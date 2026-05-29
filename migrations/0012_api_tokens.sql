-- 0012_api_tokens.sql — Phase 5 § A1: long-lived, non-interactive API tokens.
--
-- Apply via Studio SQL editor (or docker exec psql as supabase_admin) on the
-- target instance, after 0001-0011.
--
-- Background (docs/phase-5-checklist.md § A):
--   Non-interactive callers (the Phase 5 PR-merge GitHub Action, cron jobs,
--   CI) cannot run the interactive GitHub-OAuth browser flow. This migration
--   backs a refresh/access token split:
--
--     * The OPAQUE token (`tbk_…`) is the durable, revocable credential. It
--       is stored here ONLY as a SHA-256 hash (`public.api_tokens.token_hash`);
--       the plaintext is shown once, at issuance, and never persisted.
--     * The `teambrain-token` edge function (§ A2) exchanges a valid opaque
--       token for a short-lived (15 min) HS256 JWT minted for the project's
--       bot user. That JWT drives the existing MCP/REST surface through the
--       EXISTING RLS — this migration adds no new happy-path policy logic,
--       only a capability fence (below).
--
--   Identity: each project gets one per-project bot (an `auth.users` row,
--   `user_metadata.teambrain_bot = true`) with a `project_members` row
--   (`role = contributor`, `is_service_account = true`). `contributor` is the
--   floor — 0002's `thoughts_insert_self` requires `app.is_project_writer`
--   to capture `project` scope. The bot is provisioned lazily by § A2 on the
--   first token issued for a project; `projects.bot_user_id` points at it.
--
--   Capability fence (call (a) — enforced in RLS, not just app code): the
--   minted JWT is a valid `contributor` token, so a holder could otherwise
--   reach PostgREST directly and exceed the intended capability set. We make
--   "capture + read, no project_private" a real DB-level boundary by keying
--   the `public.thoughts` policies off a `teambrain_token` JWT claim:
--     * SELECT / INSERT — additionally require the row's scope to be in the
--       token's `teambrain_allowed_scopes` claim (default excludes
--       project_private). Human JWTs carry no such claim and are unaffected.
--     * UPDATE / DELETE — denied entirely for token calls. mark_stale is an
--       UPDATE and promote-style edits are UPDATEs; token callers are
--       capture + read only.
--
-- Conventions (from 0001/0002/0008 + project memory):
--   * Helpers live in the `app` schema (off the PostgREST-exposed surface,
--     so lint 0028/0029 does not flag them as RPC). SECURITY INVOKER is
--     correct here — they only read the request's JWT claims GUC, touch no
--     tables, and must observe the caller's own claims.
--   * `set search_path = ''`; fully qualify catalog functions
--     (`pg_catalog.*`). NULLIF/COALESCE/CASE/ANY are SQL constructs, not
--     schema functions, so they need no qualification.
--   * `gen_random_uuid()` (pgcrypto in `extensions`) resolves unqualified
--     via the stack's default search_path, as in 0001.
--   * No DROP TABLE, no TRUNCATE, no unqualified DELETE. Token revocation is
--     a soft UPDATE of `revoked_at`. Policy drop+recreate is required to
--     amend predicates (Studio flags it "destructive"; expected and safe).
--   * Single transaction: the capability fence and the table land together,
--     so no window exists where the table is present but unfenced.

begin;

-- 1. JWT-claim helpers (app schema, SECURITY INVOKER) -------------------------
--
-- `app.jwt_claims()` centralizes the GUC read so the two predicates below
-- share one parse. PostgREST sets `request.jwt.claims` to the verified JWT
-- payload on every request; it is unset (NULL) for service_role internal
-- paths and any non-PostgREST context, in which case we coalesce to '{}'.

create or replace function app.jwt_claims()
returns jsonb
language sql
security invoker
set search_path = ''
stable
as $$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

-- True only when the caller's JWT carries `teambrain_token: true` — i.e. the
-- request is authenticated by an exchanged API token, not a human OAuth JWT.
create or replace function app.is_token_call()
returns boolean
language sql
security invoker
set search_path = ''
stable
as $$
  select coalesce((app.jwt_claims() ->> 'teambrain_token')::boolean, false);
$$;

-- The token's permitted scopes, from the `teambrain_allowed_scopes` claim
-- (a JSON string array). Returns NULL for a human JWT (claim absent) or a
-- token JWT missing the claim — callers AND this behind `is_token_call()`,
-- and `scope = any(NULL)` is NULL (deny), so a malformed token fails closed.
create or replace function app.token_allowed_scopes()
returns text[]
language sql
security invoker
set search_path = ''
stable
as $$
  select pg_catalog.array_agg(value)
  from pg_catalog.jsonb_array_elements_text(
    app.jwt_claims() -> 'teambrain_allowed_scopes'
  ) as t(value);
$$;

grant execute on function app.jwt_claims()            to authenticated;
grant execute on function app.is_token_call()         to authenticated;
grant execute on function app.token_allowed_scopes()  to authenticated;

-- 2. api_tokens table (public schema, service_role only) ---------------------
--
-- Operational table touched exclusively by the `teambrain-token` edge
-- function. That function reaches it through the service-role supabase-js
-- client, i.e. via PostgREST — and PostgREST only routes to schemas in
-- PGRST_DB_SCHEMAS (default `public`). So unlike the RLS-plumbing helpers
-- above (which Postgres calls during policy evaluation, never over REST and
-- so correctly live in `app`), this TABLE must live in `public` to be
-- reachable. We lock it down exactly as `public.sync_runs` (0009): RLS on,
-- no SELECT policy, grants revoked from anon/authenticated, full DML to
-- service_role (which has BYPASSRLS). It is never client-readable — token
-- listing goes through the edge function's admin gate, not PostgREST.

create table if not exists public.api_tokens (
  id                 uuid        primary key default gen_random_uuid(),

  -- SHA-256 hex of the opaque token. The plaintext is never stored. Lookup
  -- is an indexed equality on this high-entropy digest, so no constant-time
  -- compare is needed (there is no secret-to-secret comparison).
  token_hash         text        not null unique,
  -- First chars of the plaintext (e.g. 'tbk_AbCd1234') for display in the
  -- token list. Not sensitive on its own.
  token_prefix       text        not null,

  principal_user_id  uuid        not null references auth.users(id)      on delete cascade,
  project_id         uuid        not null references public.projects(id) on delete cascade,

  -- Capability set baked into every JWT minted from this token.
  allowed_tools      text[]      not null default
                       array['capture_project_thought',
                             'search_project_thoughts',
                             'list_recent_project_thoughts'],
  allowed_scopes     text[]      not null default array['project', 'personal'],

  name               text,                                   -- human label
  created_by         uuid        references auth.users(id) on delete set null,
  created_at         timestamptz not null default pg_catalog.now(),
  last_used_at       timestamptz,
  -- Default lifetime is 180 days (call (b)); § A2 may pass an explicit value.
  expires_at         timestamptz not null default (pg_catalog.now() + '180 days'::interval),
  revoked_at         timestamptz,

  -- allowed_scopes must be a subset of the real scope vocabulary. This is
  -- what keeps the default (and the current policy decision) honest:
  -- project_private is simply omitted from the default set.
  constraint api_tokens_allowed_scopes_valid check (
    allowed_scopes <@ array['personal', 'project', 'project_private']
  )
);

comment on table public.api_tokens is
  'Long-lived, non-interactive API tokens. Stored as SHA-256 hashes; exchanged by the teambrain-token edge function for short-lived per-project-bot JWTs. service_role only.';
comment on column public.api_tokens.token_hash is
  'SHA-256 hex of the opaque tbk_ token. Plaintext is shown once at issuance and never persisted.';
comment on column public.api_tokens.allowed_scopes is
  'Scopes the minted JWT may act on; surfaced as the teambrain_allowed_scopes claim and enforced by RLS on public.thoughts.';
comment on column public.api_tokens.revoked_at is
  'When set, the token is revoked: exchange refuses to mint, taking effect within the 15-min access-token TTL. Soft — rows are never deleted.';

-- Active-token listing for a project (GET /token). Tombstoned/revoked rows
-- are a minority and rarely listed.
create index if not exists api_tokens_project_active_idx
  on public.api_tokens (project_id)
  where revoked_at is null;

alter table public.api_tokens enable row level security;

-- Lock down: anon/authenticated get nothing (no grant + no policy → RLS
-- denies even a future accidental grant). service_role bypasses RLS but
-- still needs the explicit table grant on self-hosted Supabase (0001/0009).
revoke all on public.api_tokens from anon;
revoke all on public.api_tokens from authenticated;
grant select, insert, update on public.api_tokens to service_role;

-- 3. projects.bot_user_id — per-project service-account pointer --------------

alter table public.projects
  add column if not exists bot_user_id uuid references auth.users(id) on delete set null;

comment on column public.projects.bot_user_id is
  'The per-project service-account auth.users id. Set by teambrain-token when the first token is issued for the project; tokens authenticate AS this principal.';

-- 4. project_members.is_service_account — membership-sync exemption ----------
--
-- The bot has no GitHub identity, so the Phase 3 membership sync would
-- tombstone it on every run (it is never in the GitHub-derived "desired"
-- set). § A3 patches teambrain-membership-sync/sync.ts to skip rows where
-- this flag is true; this column is what that check reads.

alter table public.project_members
  add column if not exists is_service_account boolean not null default false;

comment on column public.project_members.is_service_account is
  'True for per-project bot rows. teambrain-membership-sync never tombstones these (they have no GitHub identity to reconcile against).';

-- 5. Capability fence on public.thoughts -------------------------------------
--
-- Drop + recreate the four 0002 policies, reproducing their existing
-- predicates verbatim and AND-ing the token fence. Humans (no teambrain_token
-- claim) are unaffected: `not app.is_token_call()` is true for them, so the
-- added clause short-circuits and the policy reduces to its 0002 form.

-- 5a. SELECT — token calls may only read their allowed scopes.
drop policy if exists thoughts_select on public.thoughts;
create policy thoughts_select
  on public.thoughts
  for select
  to authenticated
  using (
    (
      (scope = 'personal'
        and author_user_id = (select auth.uid()))
      or
      (scope = 'project'
        and app.is_project_member(project_id))
      or
      (scope = 'project_private'
        and app.is_project_writer(project_id))
    )
    and (
      not (select app.is_token_call())
      or scope::text = any((select app.token_allowed_scopes()))
    )
  );
comment on policy thoughts_select on public.thoughts is
  'Read by scope: personal → author; project → member; project_private → admin/contributor. Token calls are further limited to teambrain_allowed_scopes.';

-- 5b. INSERT — token calls may only capture into their allowed scopes
-- (default set excludes project_private).
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
    and (
      not (select app.is_token_call())
      or scope::text = any((select app.token_allowed_scopes()))
    )
  );
comment on policy thoughts_insert_self on public.thoughts is
  'Insert: author = self; project/project_private require writer role. Token calls are further limited to teambrain_allowed_scopes.';

-- 5c. UPDATE — denied entirely for token calls (mark_stale is an UPDATE).
drop policy if exists thoughts_update_self_or_writer on public.thoughts;
create policy thoughts_update_self_or_writer
  on public.thoughts
  for update
  to authenticated
  using (
    not (select app.is_token_call())
    and (
      author_user_id = (select auth.uid())
      or (scope in ('project', 'project_private')
          and app.is_project_writer(project_id))
    )
  )
  with check (
    not (select app.is_token_call())
    and (
      author_user_id = (select auth.uid())
      or (scope in ('project', 'project_private')
          and app.is_project_writer(project_id))
    )
  );
comment on policy thoughts_update_self_or_writer on public.thoughts is
  'Update: own row, or any project row where caller is writer. Token calls are denied (capture + read only).';

-- 5d. DELETE — denied entirely for token calls.
drop policy if exists thoughts_delete_own_or_admin on public.thoughts;
create policy thoughts_delete_own_or_admin
  on public.thoughts
  for delete
  to authenticated
  using (
    not (select app.is_token_call())
    and (
      author_user_id = (select auth.uid())
      or (scope in ('project', 'project_private')
          and app.is_project_admin(project_id))
    )
  );
comment on policy thoughts_delete_own_or_admin on public.thoughts is
  'Delete: own row, or any project row where caller is admin. Token calls are denied (capture + read only).';

commit;

-- Verification (read-only — run from Studio SQL editor):
--
--   -- A. Helpers + table landed.
--   select proname from pg_proc
--   where pronamespace = 'app'::regnamespace
--     and proname in ('jwt_claims', 'is_token_call', 'token_allowed_scopes');
--   -- expect 3 rows.
--
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'api_tokens';
--   -- expect the full column set; table exists.
--
--   select column_name from information_schema.columns
--   where (table_schema, table_name, column_name) in
--     (('public','projects','bot_user_id'),
--      ('public','project_members','is_service_account'));
--   -- expect 2 rows.
--
--   -- B. Human path unaffected: with no token claim, the fence is inert.
--   set local role authenticated;
--   set local "request.jwt.claims" = '{"sub":"<a-member-uuid>","role":"authenticated"}';
--   select app.is_token_call();            -- expect f
--   select app.token_allowed_scopes();     -- expect NULL
--
--   -- C. Token path: a capture+read token sees only project/personal,
--   --    cannot touch project_private, cannot update/delete.
--   set local "request.jwt.claims" = '{"sub":"<bot-uuid>","role":"authenticated",'
--     '"teambrain_token":true,"teambrain_allowed_scopes":["project","personal"]}';
--   select app.is_token_call();            -- expect t
--   select app.token_allowed_scopes();     -- expect {project,personal}
--   --   A project_private SELECT returns 0 rows; a project_private INSERT and
--   --   any UPDATE/DELETE raise a row-level-security violation. A project-scope
--   --   INSERT (author_user_id = bot, the bot is a contributor) succeeds.
--   reset role;
</content>
