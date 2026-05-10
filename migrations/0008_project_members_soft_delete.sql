-- 0008_project_members_soft_delete.sql — Phase 3 prerequisite: turn
-- `project_members` removal into a soft-delete.
--
-- Apply via Studio SQL editor on the scratch instance, after 0007.
--
-- Background (from `docs/phase-3-checklist.md` § A4):
--   Phase 3's sync edge function reconciles `project_members` against
--   GitHub. When a user is removed from GitHub, the sync needs to revoke
--   their access in TeamBrain. Two reasonable shapes:
--
--     a) DELETE the row. Lossy: we cannot tell "never was a member" from
--        "was a member, removed at time X." Bad for audit ("who saw
--        what?") and bad for restore ("oops, GitHub team was
--        misconfigured for an hour").
--     b) Set `removed_at = now()`. Audit-friendly; restore is a one-line
--        UPDATE; RLS just has to learn to ignore tombstoned rows.
--
--   We pick (b). The whole RLS surface goes through three helpers
--   (`app.is_project_member`, `app.is_project_writer`,
--   `app.is_project_admin`) — patching those once filters tombstones
--   everywhere RLS evaluates without rewriting any policy.
--
-- What this migration does:
--   1. Adds `removed_at timestamptz` to `public.project_members`.
--   2. Replaces the three `app.is_project_*` helpers with versions that
--      filter `removed_at IS NULL`. Same signature, so RLS policies in
--      0002 keep working untouched.
--   3. Adjusts the `project_members_select_self_or_admin` policy to
--      hide tombstoned rows from the user themselves — a removed
--      member should not see their old membership row.
--   4. Adds a partial index for the active-member fast path.
--
-- What this migration does NOT do:
--   * No DELETE of any existing rows.
--   * No retroactive `removed_at` stamping — the column starts NULL on
--     every existing row, which is correct (none have been removed
--     yet).
--   * No automatic restore semantics. The Phase 3 sync function will
--     un-tombstone (set `removed_at = NULL`) when a previously removed
--     member reappears in GitHub; that logic is application-side, not
--     in the schema.

begin;

-- 1. Add the soft-delete column ----------------------------------------------

alter table public.project_members
  add column if not exists removed_at timestamptz;

comment on column public.project_members.removed_at is
  'When set, this membership row is a tombstone: ignored by RLS, retained for audit. Cleared on re-add.';

-- Partial index for "list active members of project X" — the most
-- common access pattern. Tombstoned rows are a minority and lookups for
-- audit ("show me everyone who was ever in this project") are rare and
-- can scan.
create index if not exists project_members_active_idx
  on public.project_members (project_id, user_id)
  where removed_at is null;

-- 2. Patch the three RLS helpers ---------------------------------------------
--
-- Same signatures, security definer, search_path = '' as 0002. The only
-- change is the added `and removed_at is null` predicate. `create or
-- replace function` keeps existing grants on `authenticated` intact —
-- we do not need to re-grant.

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
      and removed_at is null
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
      and removed_at is null
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
      and removed_at is null
      and role       = 'admin'::public.member_role
  );
$$;

-- 3. Tighten the project_members SELECT policy -------------------------------
--
-- 0002's policy lets a user see their own membership row. Without a
-- tombstone filter, a removed user could still SELECT their old row and
-- see "I used to be a member of project X with role Y" — minor info
-- leak, easy to close. Admins still see tombstoned rows for their
-- project (they need to see the audit trail).

drop policy if exists project_members_select_self_or_admin on public.project_members;
create policy project_members_select_self_or_admin
  on public.project_members
  for select
  to authenticated
  using (
    (user_id = (select auth.uid()) and removed_at is null)
    or app.is_project_admin(project_id)
  );
comment on policy project_members_select_self_or_admin on public.project_members is
  'Select: own active membership rows (tombstones hidden from self), plus all rows incl. tombstones for projects where caller is admin.';

commit;

-- Verification (read-only — run from Studio SQL editor):
--
--   -- A. Schema change landed.
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'project_members'
--     and column_name = 'removed_at';
--   -- expect 1 row: timestamp with time zone, YES nullable.
--
--   -- B. Existing rows are still active (no migration data corruption).
--   select count(*) filter (where removed_at is null)  as active,
--          count(*) filter (where removed_at is not null) as tombstoned,
--          count(*) as total
--   from public.project_members;
--   -- expect: active = total, tombstoned = 0.
--
--   -- C. Helper sees tombstoned rows as not-a-member. Pick a known member
--   --    and impersonate them (replace the literal user_id below):
--   --
--   --   set local role authenticated;
--   --   set local "request.jwt.claims" = '{"sub":"<that-uuid>","role":"authenticated"}';
--   --   select app.is_project_member('<project-uuid>'::uuid);   -- expect t
--   --   update public.project_members set removed_at = pg_catalog.now()
--   --     where user_id = '<that-uuid>'::uuid
--   --       and project_id = '<project-uuid>'::uuid;
--   --   select app.is_project_member('<project-uuid>'::uuid);   -- expect f
--   --   update public.project_members set removed_at = null
--   --     where user_id = '<that-uuid>'::uuid
--   --       and project_id = '<project-uuid>'::uuid;            -- restore
