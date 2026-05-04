-- 0002_rls.sql — TeamBrain row-level security (Phase 1).
--
-- Apply via Studio SQL editor on the scratch instance, after 0001_init.sql.
-- This file enables RLS on all three tables, defines three SECURITY DEFINER
-- helper functions for membership lookups, adds the policy set for the
-- personal | project | project_private scope model, and finally grants
-- table access to `authenticated`. Order matters: grants come last so the
-- window where authenticated could query a table without policies in place
-- never opens (every statement in this file runs in a single transaction).
--
-- Re-runnable: every `create policy` is preceded by `drop policy if exists`,
-- which Studio flags as a "destructive operation" — that warning is expected
-- and safe (the drop is conditional on the policy already existing). Helper
-- functions use `create or replace` and so re-run silently.
--
-- Why SECURITY DEFINER on the helpers (an exception to the usual security
-- invoker default for new functions):
--   * They are called from inside RLS policies that themselves filter rows
--     via the same project_members table they're querying. Running as
--     invoker would re-enter project_members's policy on every lookup,
--     creating recursion and significant planner overhead. Definer bypasses
--     that internal RLS evaluation.
--   * They are read-only (`select` only), `stable`, and lock `search_path`
--     to '' — so the usual security-definer footguns (SQL-injection via
--     unqualified references, write-side effects) do not apply.
--   * `auth.uid()` returns the *caller's* UUID regardless of function
--     ownership: it reads from request.jwt.claims, not from the owner's
--     identity. Definer does not impersonate; it only bypasses RLS.
--
-- Why the helpers live in the `app` schema instead of `public`:
--   * The Supabase database linter (lint 0028 / 0029) flags any SECURITY
--     DEFINER function in an API-exposed schema as a public RPC surface:
--     `/rest/v1/rpc/<fn>` would let anon/authenticated invoke the helper
--     directly. RLS still filters their row access — but exposing the
--     helper as RPC is needless surface area.
--   * PostgREST's `PGRST_DB_SCHEMAS` is `public` by default; functions in
--     `app` are unreachable via REST and invisible to pg_graphql, while
--     RLS policies on `public.*` tables can still call them as long as
--     `authenticated` has USAGE on `app` and EXECUTE on the function.
--   * We do not grant `app` schema usage to `anon` — anon never triggers
--     an RLS policy that would need the helpers (anon has no table
--     SELECT after the revoke block below).

begin;

-- 1. Lock down anon access + enable RLS --------------------------------------

-- Self-hosted Supabase's docker init grants SELECT on `public` to anon via
-- default privileges. TeamBrain has no anonymous-readable surface — every
-- piece of memory is bound to either an author (personal) or a project
-- membership (project, project_private). Revoke unconditionally so the
-- pg_graphql lint does not flag the tables as anon-discoverable, and so
-- a future grant slip cannot accidentally expose them.
revoke all on public.projects        from anon;
revoke all on public.project_members from anon;
revoke all on public.thoughts        from anon;

-- After this, every query from `authenticated` returns zero rows until a
-- policy permits it. `service_role` has BYPASSRLS at the role level on
-- self-hosted Supabase, so it is unaffected — no explicit policy is needed
-- for service_role and adding one would be cargo-culted noise.
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.thoughts        enable row level security;

-- 2. RLS helper functions (in `app` schema, not `public`) --------------------

-- All three return boolean, are stable (planner can fold + cache), and
-- bypass internal RLS via security definer (see file header for rationale).
-- `(select auth.uid())` is a Supabase-recommended pattern that lets the
-- planner evaluate auth.uid() once per query rather than once per row.

create schema if not exists app;
-- USAGE only — `authenticated` can resolve `app.is_project_member` from
-- inside an RLS policy, but the schema is not exposed via PostgREST or
-- pg_graphql (those only inspect schemas listed in PGRST_DB_SCHEMAS,
-- default `public`). Anon gets no USAGE — it has no table grants and so
-- never enters an RLS path that would call these.
grant usage on schema app to authenticated;

create or replace function app.is_project_member(p uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.project_members
    where project_id = p
      and user_id    = (select auth.uid())
  );
$$;

create or replace function app.is_project_writer(p uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.project_members
    where project_id = p
      and user_id    = (select auth.uid())
      and role       in ('admin'::public.member_role, 'contributor'::public.member_role)
  );
$$;

create or replace function app.is_project_admin(p uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.project_members
    where project_id = p
      and user_id    = (select auth.uid())
      and role       = 'admin'::public.member_role
  );
$$;

grant execute on function app.is_project_member(uuid) to authenticated;
grant execute on function app.is_project_writer(uuid) to authenticated;
grant execute on function app.is_project_admin(uuid)  to authenticated;

-- 3. Policies on public.thoughts ---------------------------------------------

-- 3a. SELECT — three orthogonal scope predicates, OR-combined in a single
-- policy. Splitting into one policy per scope reads more cleanly in the
-- policy browser, but Supabase's "Multiple Permissive Policies" lint
-- (0006, performance) flags it: each per-scope policy is evaluated
-- against every candidate row before the OR short-circuits. Merging
-- collapses that to one expression per row and matches the shape we
-- already use for update/delete (single policy, OR'd predicates).
--
-- The structural CHECK constraint from 0001 guarantees scope and
-- project_id are consistent, so each branch below only has to verify
-- the membership/authorship predicate for its scope.
--
-- Drop the legacy per-scope policy names too — earlier revisions of
-- this file created them. Without these drops, re-running on a scratch
-- instance that already has the per-scope policies would leave them in
-- place alongside the merged policy, restoring the lint warning.
drop policy if exists thoughts_select_personal        on public.thoughts;
drop policy if exists thoughts_select_project         on public.thoughts;
drop policy if exists thoughts_select_project_private on public.thoughts;

drop policy if exists thoughts_select on public.thoughts;
create policy thoughts_select
  on public.thoughts
  for select
  to authenticated
  using (
    (scope = 'personal'
      and author_user_id = (select auth.uid()))
    or
    (scope = 'project'
      and app.is_project_member(project_id))
    or
    (scope = 'project_private'
      and app.is_project_writer(project_id))
  );
comment on policy thoughts_select on public.thoughts is
  'Read access by scope: personal → author only; project → any member; project_private → admin/contributor only.';

-- 3b. INSERT — caller must be claiming themselves as author, and have the
-- right to write at the requested scope. The CHECK constraint from 0001
-- already guarantees scope ↔ project_id consistency, so this policy does
-- not need to re-validate that.

drop policy if exists thoughts_insert_self on public.thoughts;
create policy thoughts_insert_self
  on public.thoughts
  for insert
  to authenticated
  with check (
    author_user_id = (select auth.uid())
    and (
      scope = 'personal'
      or (scope in ('project', 'project_private')
          and app.is_project_writer(project_id))
    )
  );
comment on policy thoughts_insert_self on public.thoughts is
  'Insert: caller must set author_user_id = self; project/project_private require admin or contributor role.';

-- 3c. UPDATE — author can edit their own row at any scope; project writers
-- can edit any row in their project. WITH CHECK mirrors USING to prevent a
-- writer from rewriting a row into a state that would deny re-access.
-- Note: this does not block a writer from rewriting `author_user_id` or
-- changing `scope` — guarding those would require a BEFORE UPDATE trigger.
-- Phase 1 trusts the 2-3 hand-seeded pilot devs; revisit if abuse appears.

drop policy if exists thoughts_update_self_or_writer on public.thoughts;
create policy thoughts_update_self_or_writer
  on public.thoughts
  for update
  to authenticated
  using (
    author_user_id = (select auth.uid())
    or (scope in ('project', 'project_private')
        and app.is_project_writer(project_id))
  )
  with check (
    author_user_id = (select auth.uid())
    or (scope in ('project', 'project_private')
        and app.is_project_writer(project_id))
  );
comment on policy thoughts_update_self_or_writer on public.thoughts is
  'Update: own row at any scope, or any project/project_private row in a project where caller is admin/contributor.';

-- 3d. DELETE — author can delete their own; project admins (only) can
-- delete any row in their project. Contributors cannot delete each other's
-- thoughts — that asymmetry vs. update is intentional.

drop policy if exists thoughts_delete_own_or_admin on public.thoughts;
create policy thoughts_delete_own_or_admin
  on public.thoughts
  for delete
  to authenticated
  using (
    author_user_id = (select auth.uid())
    or (scope in ('project', 'project_private')
        and app.is_project_admin(project_id))
  );
comment on policy thoughts_delete_own_or_admin on public.thoughts is
  'Delete: own row at any scope, or any project/project_private row where caller is admin (contributors cannot delete others).';

-- 4. Policies on public.projects ---------------------------------------------

drop policy if exists projects_select_member on public.projects;
create policy projects_select_member
  on public.projects
  for select
  to authenticated
  using (app.is_project_member(id));
comment on policy projects_select_member on public.projects is
  'A project row is visible to any member of that project.';

-- Phase 1 placeholder: any authenticated user may create a project where
-- they are the creator. Phase 3 admin-sync edge function will tighten this
-- (e.g., must be in the FABRIC GitHub org). For now the friction is low —
-- creating a project also requires the creator to immediately seed
-- themselves into project_members via service_role (RLS denies them write
-- on project_members), so accidental project sprawl is self-limiting.

drop policy if exists projects_insert_authenticated on public.projects;
create policy projects_insert_authenticated
  on public.projects
  for insert
  to authenticated
  with check (created_by = (select auth.uid()));
comment on policy projects_insert_authenticated on public.projects is
  'Insert: caller must set created_by = self. Phase 1 placeholder; Phase 3 will gate this on org membership.';

-- No update/delete policies on projects in Phase 1 — administrative changes
-- (renames, archive) go through service_role until we have an admin UI.

-- 5. Policies on public.project_members --------------------------------------

-- A user can see their own membership rows + all membership rows for any
-- project where they are admin (admins need to see who else is in their
-- project). Non-admins cannot enumerate other members of their project —
-- that is intentional privacy hygiene; we surface "who else can see this"
-- through a project-level admin view in Phase 3, not a raw table read.
--
-- Note: the inner subquery on project_members would normally recurse
-- through this same policy, but is_project_admin() is SECURITY DEFINER
-- and bypasses RLS internally. That is precisely why the helpers exist.

drop policy if exists project_members_select_self_or_admin on public.project_members;
create policy project_members_select_self_or_admin
  on public.project_members
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or app.is_project_admin(project_id)
  );
comment on policy project_members_select_self_or_admin on public.project_members is
  'Select: own membership rows, plus all rows for projects where caller is admin.';

-- No insert/update/delete policies on project_members in Phase 1 —
-- membership writes go through service_role only (the seed file uses it,
-- and the Phase 3 sync edge function will too). Hand-seeded membership is
-- the correct pattern for a 2-3 person pilot.

-- 6. Table-level grants for `authenticated` ----------------------------------

-- Without these grants, the policies above are inert: authenticated would
-- be denied at the table-grant layer before RLS even gets a chance to
-- evaluate. Grant + policy is the Supabase pairing — both are required.

grant select, insert, update, delete on public.thoughts        to authenticated;
grant select, insert                  on public.projects        to authenticated;
grant select                          on public.project_members to authenticated;

commit;
