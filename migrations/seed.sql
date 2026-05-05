-- seed.sql — TeamBrain Phase 1 pilot data (hand-seeded membership).
--
-- Apply via Studio SQL editor on the scratch instance, after 0001/0002/0003.
-- This file is **not** a numbered migration — it is data, not schema, and
-- it is safe to re-run any number of times. Every insert is guarded by
-- `on conflict ... do nothing` (or `do update` where idempotent overwrite
-- is intended).
--
-- What's in here:
--   1. One `projects` row for `fabric-testbed/fabric-core-api` (the Phase 7
--      pilot repo, decided 2026-05-03). Deterministic UUID so test fixtures
--      and downstream migrations can hard-reference it.
--   2. `project_members` rows for the pilot devs, resolved by GitHub handle
--      against `auth.users.raw_user_meta_data->>'user_name'`. The CTE
--      gracefully skips users whose `auth.users` row does not exist yet —
--      so the seed can be applied before every dev has completed their
--      first OAuth login on scratch, then re-applied as each new login
--      lands.
--
-- What's NOT in here:
--   * No `auth.users` inserts. Those rows come from real GitHub OAuth
--     round-trips through GoTrue (D7 of Phase 0). Seeding `auth.users`
--     directly bypasses GoTrue's identity-linking and produces orphan rows.
--   * No `thoughts` inserts. Thought-content seeding is a separate, optional
--     step (Phase 0 B1 follow-up: "any existing tribal knowledge about
--     fabric-core-api that should be seeded as initial memories?"). Keep
--     this file membership-only so it stays a clean reference for what
--     "set up the pilot" looks like.
--
-- Pilot dev list (update as Phase 0 B1 confirms additional reviewers):
--   * mjstealey  — Michael (admin, primary committer, also the seeder)
--   * kthare10   — Komal Thareja (contributor, primary reviewer; handle
--                                 confirmed against https://github.com/kthare10)

begin;

-- 1. Pilot project row -------------------------------------------------------

-- Deterministic UUID `00000000-0000-0000-0000-00000000c0a1` ("c0a1" = "core
-- api"). Pre-seeded by Phase 0 B3 sanity inserts on scratch — this insert
-- is a no-op there, but creates the row on a fresh DB. `created_by` is left
-- null at first apply (seed is data, not user action); the first
-- subsequent admin to claim ownership can update it via service_role.
insert into public.projects (id, repo_slug, name, created_by)
values (
  '00000000-0000-0000-0000-00000000c0a1'::uuid,
  'fabric-testbed/fabric-core-api',
  'FABRIC Core API',
  null
)
on conflict (id) do nothing;

-- 2. Pilot membership --------------------------------------------------------

-- Resolves GitHub handles → auth.users.id via the `raw_user_meta_data`
-- column GoTrue populates on first OAuth login. Users without a row yet
-- (e.g. Komal before her first sign-in) are silently skipped — the CTE's
-- where-clause filters them out before the upsert.
--
-- `on conflict (project_id, user_id) do update set role = excluded.role`
-- means re-running this file will fix any role drift (e.g. if a member was
-- accidentally demoted in Studio). If you want strict no-overwrite
-- semantics, swap the action for `do nothing`.

with desired_members (gh_handle, role) as (
  values
    ('mjstealey', 'admin'),
    ('kthare10',  'contributor')   -- Komal Thareja, handle confirmed.
),
resolved as (
  select u.id as user_id, dm.role
  from desired_members dm
  join auth.users u
    on u.raw_user_meta_data->>'user_name' = dm.gh_handle
)
insert into public.project_members (project_id, user_id, role)
select
  '00000000-0000-0000-0000-00000000c0a1'::uuid,
  user_id,
  role::public.member_role
from resolved
on conflict (project_id, user_id) do update
  set role = excluded.role;

-- 3. Verification (read-only, kept inline so the seed is self-checking) ------

-- Lists every member that the seed successfully resolved + inserted.
-- Should show exactly the rows whose `gh_handle` had a matching auth.users
-- row at apply time. If a row is missing, that user has not yet completed
-- the GitHub OAuth round-trip on scratch.
select
  pm.role,
  u.raw_user_meta_data->>'user_name' as gh_handle,
  pm.project_id,
  pm.created_at
from public.project_members pm
join auth.users u on u.id = pm.user_id
where pm.project_id = '00000000-0000-0000-0000-00000000c0a1'::uuid
order by pm.role, gh_handle;

commit;
