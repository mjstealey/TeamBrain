-- 0004_match_thoughts.sql — semantic search RPC over public.thoughts.
--
-- Apply via Studio SQL editor on the scratch instance, after 0001-0003 +
-- seed.sql. This file adds a single function: `public.match_thoughts(...)`,
-- the project-scoped semantic-search entry point that the Phase 2 MCP
-- edge function calls via PostgREST RPC (/rest/v1/rpc/match_thoughts).
--
-- Why SECURITY INVOKER (not DEFINER, unlike the helpers in 0002):
--   * The whole point of Phase 1's RLS work is that filtering happens at
--     the row layer, automatically, on every read. SECURITY INVOKER means
--     the function body executes as the calling role — so when it does
--     `from public.thoughts t`, RLS on `thoughts` evaluates against the
--     caller's auth.uid() and the `thoughts_select` policy filters
--     project/personal/project_private rows correctly.
--   * SECURITY DEFINER would BYPASS that RLS and force us to re-implement
--     scope filtering in the function body — exactly the duplication we
--     designed RLS to avoid.
--   * The `app.is_project_*` helpers in 0002 are DEFINER for a different
--     reason (avoiding recursive RLS evaluation on `project_members`).
--     `match_thoughts` does not have that problem; it reads `thoughts`
--     once with no recursive lookup back to itself.
--
-- Why this lives in `public` (not `app`):
--   * It IS a legitimate API surface — the MCP edge function calls it via
--     `userClient.rpc('match_thoughts', {...})`, which goes through
--     PostgREST's /rest/v1/rpc/ handler. PostgREST only exposes functions
--     in schemas listed in PGRST_DB_SCHEMAS (default `public`).
--   * The `app.is_project_*` helpers are RLS plumbing, not API surface;
--     this function is the opposite — explicitly intended for client RPC.
--
-- Conventions enforced:
--   * `language sql`, `stable` — planner can fold + cache; no plpgsql
--     needed for a single SELECT.
--   * `set search_path = ''` — every reference fully qualified, including
--     the pgvector cosine-distance operator via `OPERATOR(extensions.<=>)`.
--     Without that qualifier, the operator resolves through search_path
--     and Studio's Security Advisor flags "Function Search Path Mutable".
--   * `is not null` guard on embedding — rows captured before embeddings
--     were wired (e.g., the Phase 1 B3 sanity-test rows) silently drop
--     out of search results rather than producing distance-against-null.

begin;

create or replace function public.match_thoughts(
  query_embedding   extensions.vector(1536),
  match_count       int                     default 10,
  match_threshold   float                   default 0.5,
  filter_project_id uuid                    default null,
  filter_scopes     public.thought_scope[]  default null
)
returns table (
  id                uuid,
  content           text,
  scope             public.thought_scope,
  type              public.thought_type,
  project_id        uuid,
  author_user_id    uuid,
  similarity        float,
  created_at        timestamptz,
  last_verified_at  timestamptz,
  tags              text[]
)
language sql
security invoker
stable
set search_path = ''
as $$
  select
    t.id,
    t.content,
    t.scope,
    t.type,
    t.project_id,
    t.author_user_id,
    1 - (t.embedding operator(extensions.<=>) query_embedding) as similarity,
    t.created_at,
    t.last_verified_at,
    t.tags
  from public.thoughts t
  where t.embedding is not null
    and (filter_project_id is null or t.project_id = filter_project_id)
    and (filter_scopes     is null or t.scope = any(filter_scopes))
    and 1 - (t.embedding operator(extensions.<=>) query_embedding) > match_threshold
  order by t.embedding operator(extensions.<=>) query_embedding
  limit greatest(match_count, 0);
$$;

-- Anon gets nothing — search is authenticated-only.
grant execute on function public.match_thoughts(
  extensions.vector(1536),
  int,
  float,
  uuid,
  public.thought_scope[]
) to authenticated;

commit;
