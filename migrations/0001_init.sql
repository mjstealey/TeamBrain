-- 0001_init.sql — TeamBrain core multi-tenant schema (Phase 1, DDL only).
--
-- Apply via Studio SQL editor on the scratch instance (https://127.0.0.1:8443
-- → Studio at http://127.0.0.1:3000). Studio runs as supabase_admin, which
-- can own functions in `public`; the `postgres` role on self-hosted Supabase
-- is not a superuser and will fail to own SECURITY-INVOKER helpers used here.
--
-- This file establishes tables, types, indexes, the updated_at trigger,
-- and base grants. Row-level security policies live in 0002_rls.sql so
-- they can be iterated independently. Re-running this file is safe — every
-- DDL statement is guarded with `if not exists` (or wrapped in a DO block
-- for ENUM creation, which has no native idempotent form).
--
-- Conventions enforced (from project memory + Supabase Security Advisor):
--   * Extensions live in the `extensions` schema, never `public`. The
--     supabase docker stack pre-creates the schema and adds it to the
--     default search_path, so `vector(1536)` and `gen_random_uuid()`
--     resolve unqualified.
--   * Functions defined here use `security invoker`, `set search_path = ''`,
--     and fully qualify all references (`pg_catalog.now()`, etc.).
--   * No DROP, no TRUNCATE, no unqualified DELETE.

begin;

-- 1. Required extensions ------------------------------------------------------

-- pgvector for embeddings; pgcrypto for gen_random_uuid().
-- WITH SCHEMA extensions is critical: putting these in `public` triggers
-- Studio's "Extension in Public" advisory and pollutes the PostgREST
-- OpenAPI surface with extension types.
create extension if not exists vector    with schema extensions;
create extension if not exists pgcrypto  with schema extensions;

-- 2. ENUM types ---------------------------------------------------------------

-- `create type` has no `if not exists`; wrap each in a DO block so re-running
-- this file on a partially-applied database is a no-op rather than an error.

do $$ begin
  create type public.thought_scope as enum ('personal', 'project', 'project_private');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.thought_type as enum
    ('decision', 'convention', 'gotcha', 'context', 'preference', 'runbook');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.thought_confidence as enum ('tentative', 'confirmed', 'deprecated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.member_role as enum ('admin', 'contributor', 'reader');
exception when duplicate_object then null; end $$;

-- 3. Tables -------------------------------------------------------------------

-- 3a. projects: one row per repo/team scope.
create table if not exists public.projects (
  id          uuid        primary key default gen_random_uuid(),
  repo_slug   text        not null unique,           -- e.g. 'fabric-testbed/fabric-core-api'
  name        text        not null,                  -- human-friendly display name
  created_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default pg_catalog.now(),
  updated_at  timestamptz not null default pg_catalog.now()
);

-- 3b. project_members: who can read/write each project's thoughts.
-- Composite primary key: a user is in a project at most once.
-- Hand-seeded in Phase 1 (see migrations/seed.sql); auto-synced from
-- GitHub collaborator/org-team APIs in Phase 3.
create table if not exists public.project_members (
  project_id  uuid         not null references public.projects(id) on delete cascade,
  user_id     uuid         not null references auth.users(id)      on delete cascade,
  role        member_role  not null default 'contributor',
  created_at  timestamptz  not null default pg_catalog.now(),
  primary key (project_id, user_id)
);

-- 3c. thoughts: the canonical memory row.
-- OB1's columns (id, content, embedding, metadata, timestamps) plus
-- TeamBrain's multi-tenant + provenance + freshness extensions.
--
-- Structural invariant (CHECK below): personal thoughts have project_id null;
-- project / project_private thoughts must have a project_id. RLS policies in
-- 0002 lean on this — they assume scope and project_id are already consistent.
create table if not exists public.thoughts (
  id                 uuid                  primary key default gen_random_uuid(),
  content            text                  not null,
  embedding          vector(1536),
  metadata           jsonb                 not null default '{}'::jsonb,

  project_id         uuid                  references public.projects(id) on delete cascade,
  scope              thought_scope         not null default 'personal',
  type               thought_type,

  author_user_id     uuid                  references auth.users(id) on delete set null,
  linked_commit_sha  text,
  linked_pr_url      text,
  linked_issue_url   text,

  last_verified_at   timestamptz,
  expires_at         timestamptz,

  paths              text[]                not null default '{}',
  confidence         thought_confidence    not null default 'tentative',
  tags               text[]                not null default '{}',

  created_at         timestamptz           not null default pg_catalog.now(),
  updated_at         timestamptz           not null default pg_catalog.now(),

  constraint thoughts_scope_project_consistency check (
    (scope = 'personal'        and project_id is null)
    or
    (scope in ('project', 'project_private') and project_id is not null)
  )
);

-- 4. Indexes ------------------------------------------------------------------

-- Primary access pattern: "list project X's thoughts at scope Y".
create index if not exists thoughts_project_scope_idx
  on public.thoughts (project_id, scope);

-- RLS personal-scope filter: `where author_user_id = auth.uid()`.
create index if not exists thoughts_author_idx
  on public.thoughts (author_user_id);

-- HNSW for cosine-distance semantic search (Phase 2 MCP).
-- vector_cosine_ops matches 1 - (a <=> b) similarity in match_thoughts().
create index if not exists thoughts_embedding_hnsw_idx
  on public.thoughts using hnsw (embedding extensions.vector_cosine_ops);

-- GIN over jsonb metadata for `metadata @> '{"key":"val"}'` filters.
create index if not exists thoughts_metadata_gin_idx
  on public.thoughts using gin (metadata);

-- GIN over tag and path arrays for `tags && array['x']` / `paths @> ...`.
create index if not exists thoughts_tags_gin_idx
  on public.thoughts using gin (tags);

create index if not exists thoughts_paths_gin_idx
  on public.thoughts using gin (paths);

-- Recency listing.
create index if not exists thoughts_created_at_idx
  on public.thoughts (created_at desc);

-- Reverse-direction membership lookup ("which projects is this user in"):
-- the composite pk already covers (project_id, user_id) lookups.
create index if not exists project_members_user_idx
  on public.project_members (user_id);

-- 5. updated_at trigger -------------------------------------------------------

-- security invoker: function executes as the calling role, not the owner —
-- correct for triggers that simply stamp a column.
-- search_path = '': forces fully qualified references inside the body.
-- pg_catalog is implicitly first on search_path even when set to '', but we
-- qualify now() explicitly anyway to silence Studio's Security Advisor.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

-- `create or replace trigger` is Postgres 14+; avoids the drop+create pattern
-- that Studio's SQL editor flags as "destructive operations".
create or replace trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

create or replace trigger thoughts_set_updated_at
  before update on public.thoughts
  for each row execute function public.set_updated_at();

-- 6. Base grants --------------------------------------------------------------

-- service_role bypasses RLS by default in PostgREST, but the table-level
-- grant is still required (Supabase no longer grants it implicitly on
-- self-hosted v15+ — see OB1 docs, "Grant service_role access").
grant select, insert, update, delete on public.projects        to service_role;
grant select, insert, update, delete on public.project_members to service_role;
grant select, insert, update, delete on public.thoughts        to service_role;

-- `authenticated` and `anon` table-level grants are deferred to 0002_rls.sql:
-- they are only safe once the policies that filter their access exist.
-- Granting before policies are in place would briefly expose every row.

commit;
