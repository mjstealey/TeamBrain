-- 0017_match_thoughts_staleness_decay.sql — freshness-aware ranking for
-- the semantic-search RPC (Phase 6 § B).
--
-- Apply via Studio SQL editor, after 0001-0016. This migration drops and
-- recreates `public.match_thoughts(...)` so that search results are ordered
-- by a staleness-adjusted score instead of raw cosine similarity alone.
-- Both read surfaces (teambrain-mcp, teambrain-rest) call this one RPC and
-- preserve its ordering, so the change reaches both for free.
--
-- WHY (the problem this fixes):
--   The 0004/0005 body orders purely by cosine distance. The schema already
--   carries three freshness signals that ranking ignored — `last_verified_at`,
--   `expires_at`, and `confidence` (tentative|confirmed|deprecated) — so a
--   confidently-stale or explicitly-deprecated memory could outrank a freshly
--   re-verified one for the same query. That is the opposite of what a living
--   memory service should do, and a Phase 7 "AI told me wrong" risk.
--
-- WHAT changes:
--   * New ORDER BY on a computed `rank_score` =
--       similarity
--       × confidence_factor   (confirmed 1.15 · tentative 1.00 · deprecated 0.40)
--       × expiry_factor       (expires_at in the past → 0.40, else 1.00)
--       × recency_factor      (decay_floor + (1-decay_floor) · freshness)
--     where freshness = exp(-ln2 · age_days / half_life_days) ∈ (0,1], i.e.
--     1.0 at age 0 and 0.5 at one half-life, measured from
--     coalesce(last_verified_at, created_at).
--   * `similarity` in the result is still the RAW cosine the caller
--     threshold-filtered on; `rank_score` is ordering-only and also returned
--     so callers can see WHY a row ranked where it did.
--   * The cosine `match_threshold` cutoff is UNCHANGED — freshness re-ranks
--     within the relevant set and never resurrects an irrelevant row.
--
-- DECISIONS baked in (see docs/development/phase-6-checklist.md § B):
--   * Decay shape: exponential, 90-day half-life, bounded below by a
--     `decay_floor` (0.5) so freshness breaks near-ties but cannot override a
--     much stronger cosine match. half_life_days / decay_floor are parameters
--     (defaulted) so the curve is tunable later WITHOUT a schema change.
--   * Deprecated rows SINK (×0.40) but stay searchable; a new
--     `include_deprecated` param (default true) lets a caller filter them out.
--   * Applied IN the RPC (not post-ranked in the edge function) so MCP + REST
--     stay consistent automatically.
--
-- Index note: the inner `candidates` CTE still does the nearest-neighbour step
--   via `ORDER BY embedding <=> query` (HNSW-accelerated) and over-fetches a
--   bounded pool; the outer query re-ranks only that pool by `rank_score`.
--   This keeps the ANN step index-backed and bounds how far freshness can
--   promote a row (a weakly-relevant fresh row outside the pool can't jump in).
--
-- Conventions kept from 0004 (unchanged rationale):
--   * `language sql`, `security invoker` (RLS filters every candidate as the
--     caller), `stable`, `set search_path = ''`.
--   * Only the pgvector cosine operator needs qualifying
--     (`OPERATOR(extensions.<=>)`); exp/ln/extract/now/greatest/least/coalesce
--     resolve from pg_catalog, which is implicit even with an empty search_path.
--
-- 768-dim deployments (the optional Ollama path of 0005): apply the SAME edit
--   with `extensions.vector(768)` swapped in for `extensions.vector(1536)` in
--   the create signature, the drop signature, and the grant — exactly as 0005
--   is the 768 rewrite of 0004. The committed body targets the production
--   1536 default.

begin;

-- Drop the prior (0004/0006-era) signature. Required because we change the
-- RETURNS TABLE shape (new columns) and add parameters, neither of which
-- `create or replace` can do in place.
drop function if exists public.match_thoughts(
  extensions.vector(1536),
  int,
  float,
  uuid,
  public.thought_scope[]
);

create function public.match_thoughts(
  query_embedding    extensions.vector(1536),
  match_count        int                     default 10,
  match_threshold    float                   default 0.5,
  filter_project_id  uuid                    default null,
  filter_scopes      public.thought_scope[]  default null,
  half_life_days     float                   default 90,
  decay_floor        float                   default 0.5,
  include_deprecated boolean                 default true
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
  expires_at        timestamptz,
  confidence        public.thought_confidence,
  tags              text[],
  rank_score        float
)
language sql
security invoker
stable
set search_path = ''
as $$
  with candidates as (
    -- ANN step: HNSW does the heavy lifting via ORDER BY distance + LIMIT.
    -- Over-fetch a bounded pool so the outer freshness re-rank has room to
    -- promote a fresher row without resurrecting weakly-relevant ones.
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
      t.expires_at,
      t.confidence,
      t.tags
    from public.thoughts t
    where t.embedding is not null
      and (filter_project_id is null or t.project_id = filter_project_id)
      and (filter_scopes     is null or t.scope = any(filter_scopes))
      and (include_deprecated or t.confidence <> 'deprecated')
      and 1 - (t.embedding operator(extensions.<=>) query_embedding) > match_threshold
    order by t.embedding operator(extensions.<=>) query_embedding
    limit greatest(match_count, 0) * 5 + 50
  )
  select
    c.id,
    c.content,
    c.scope,
    c.type,
    c.project_id,
    c.author_user_id,
    c.similarity,
    c.created_at,
    c.last_verified_at,
    c.expires_at,
    c.confidence,
    c.tags,
    c.similarity
      * (case c.confidence
           when 'confirmed'  then 1.15
           when 'tentative'  then 1.00
           when 'deprecated' then 0.40
         end)
      * (case when c.expires_at is not null and c.expires_at < now() then 0.40 else 1.00 end)
      * (greatest(least(decay_floor, 1.0), 0.0)
         + (1.0 - greatest(least(decay_floor, 1.0), 0.0))
           * exp(
               -0.6931471805599453
               * (extract(epoch from (now() - coalesce(c.last_verified_at, c.created_at))) / 86400.0)
               / greatest(half_life_days, 1.0)
             )) as rank_score
  from candidates c
  order by rank_score desc
  limit greatest(match_count, 0);
$$;

-- Anon gets nothing — search is authenticated-only.
grant execute on function public.match_thoughts(
  extensions.vector(1536),
  int,
  float,
  uuid,
  public.thought_scope[],
  float,
  float,
  boolean
) to authenticated;

commit;
