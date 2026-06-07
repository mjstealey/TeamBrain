-- 0018_staleness_signals.sql — Phase 6 § C: commit-triggered staleness flagging.
--
-- Apply via Studio SQL editor, after 0001-0017. This migration is "always"
-- (schema + the pluggable signal core + read surface). The pg_cron jobs that
-- DRIVE it are split into the production-only 0019, mirroring how 0009
-- (sync_runs, always) and 0010 (the cron, production-only) are split.
--
-- WHAT § C does (and why):
--   § B (0017) makes stale memory SINK in ranking. § C makes a memory FLAG
--   ITSELF for human re-verification when the code it is pinned to changes: a
--   commit touching a path in `thoughts.paths` flags that thought. This is the
--   "AI told me wrong" guard and the source of the Phase 7 "false-positive
--   stale flags" metric.
--
-- DESIGN (decisions resolved 2026-06-07, confirmed with Michael):
--   * Dedicated flag, NOT an overload of existing columns. New
--     `thoughts.stale_flagged_at` (null = not flagged). `last_verified_at` and
--     `confidence` stay pure HUMAN-judgment signals — the 0017 decay formula
--     reads `last_verified_at`, so writing to it from an automated producer
--     would corrupt ranking. The flag is a separate, orthogonal badge; it does
--     NOT change rank (that is § B's job).
--   * Pluggable signal interface (ADR 0001 Consequences): every producer
--     writes to `public.staleness_signals` via the one core function
--     `flag_thoughts_for_paths(...)`. `commit_touched_path` and `expires_at_hit`
--     ship now; `pr_merged` / `issue_closed` (and a future webhook transport)
--     drop in later by calling the same function — no refactor.
--   * Cleared on re-verify: a trigger nulls `stale_flagged_at` whenever
--     `last_verified_at` advances (e.g. `mark_stale`, which always bumps it),
--     regardless of the outcome ("I re-checked it" clears the re-check flag).
--   * Path matching favors low false-positives (the Done-when): exact full-path
--     overlap (via the existing `thoughts_paths_gin_idx`) plus directory-prefix
--     match only when a pinned path ends in '/'. Globs deferred.

begin;

-- 1. Flag column on thoughts --------------------------------------------------

alter table public.thoughts
  add column if not exists stale_flagged_at timestamptz;

comment on column public.thoughts.stale_flagged_at is
  'Phase 6 § C: when non-null, this thought was flagged for human re-verification '
  '(a commit touched a pinned path, an expires_at passed, etc.). Distinct from '
  'last_verified_at (human-confirmed) and confidence (human judgment). Cleared by '
  'the thoughts_clear_stale_flag_on_verify trigger when last_verified_at advances.';

-- Partial index for the `flagged_only` read filter (mirrors 0014's linked_pr_url
-- partial index): only flagged rows are indexed, cheap because most rows are not.
create index if not exists thoughts_stale_flagged_idx
  on public.thoughts (stale_flagged_at)
  where stale_flagged_at is not null;

-- 2. staleness_signals: the pluggable signal log ------------------------------
-- One row per signal event. Append-only audit + the unified interface every
-- producer writes to. RLS mirrors sync_runs (0009) but reads to project
-- MEMBERS (not just admins) — staleness is relevant to everyone working the repo.

create table if not exists public.staleness_signals (
  id          uuid        primary key default gen_random_uuid(),
  thought_id  uuid        not null references public.thoughts(id)  on delete cascade,
  project_id  uuid        references public.projects(id) on delete cascade,
  signal_kind text        not null
              check (signal_kind in ('commit_touched_path', 'pr_merged', 'expires_at_hit', 'issue_closed')),
  detail      jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default pg_catalog.now()
);

comment on table public.staleness_signals is
  'Phase 6 § C pluggable staleness-signal log. One row per signal event (commit '
  'touched a pinned path, expiry hit, future PR-merged/issue-closed). Written by '
  'service_role via flag_thoughts_for_paths(); readable by project members.';

create index if not exists staleness_signals_thought_created_idx
  on public.staleness_signals (thought_id, created_at desc);

create index if not exists staleness_signals_project_created_idx
  on public.staleness_signals (project_id, created_at desc);

alter table public.staleness_signals enable row level security;

revoke all on public.staleness_signals from anon;
grant select, insert, update, delete on public.staleness_signals to service_role;
grant select on public.staleness_signals to authenticated;

drop policy if exists staleness_signals_select_member on public.staleness_signals;
create policy staleness_signals_select_member
  on public.staleness_signals
  for select
  to authenticated
  using (project_id is not null and app.is_project_member(project_id));
comment on policy staleness_signals_select_member on public.staleness_signals is
  'Select: project members see signals scoped to their projects. Personal-scope '
  '(project_id NULL) signals are service_role-only; the badge on the thought row '
  'is the author-facing surface for those.';
-- No insert/update/delete policies — writes are service_role-only.

-- 3. staleness_poll_state: per-project commit cursor --------------------------
-- service_role-only, like app_config (0013). Holds the high-water mark so the
-- poller only diffs NEW commits each run.

create table if not exists public.staleness_poll_state (
  project_id     uuid        primary key references public.projects(id) on delete cascade,
  default_branch text,
  last_sha       text,
  last_polled_at timestamptz,
  updated_at     timestamptz not null default pg_catalog.now()
);

comment on table public.staleness_poll_state is
  'Phase 6 § C per-project commit poll cursor for teambrain-staleness /scan. '
  'service_role-only (no anon/authenticated grants).';

alter table public.staleness_poll_state enable row level security;
revoke all on public.staleness_poll_state from anon, authenticated;
grant select, insert, update, delete on public.staleness_poll_state to service_role;

-- Explicit deny-all so the lockdown is a visible schema object (mirrors 0016).
-- Cosmetic only — service_role bypasses RLS; anon/authenticated have no grant.
drop policy if exists staleness_poll_state_no_direct_access on public.staleness_poll_state;
create policy staleness_poll_state_no_direct_access on public.staleness_poll_state
  for all using (false) with check (false);

-- 4. flag_thoughts_for_paths: the reusable pluggable core ---------------------
-- SECURITY DEFINER + service_role-only. Finds thoughts in p_project_id whose
-- pinned paths match any changed path, logs a signal per match, and stamps the
-- badge (first-flag-wins; the log records every event). Returns matched ids.
-- Every signal producer (commit poller, expiry flagger, future PR/issue) calls
-- this so the matching + flagging logic lives in exactly one place.

create or replace function public.flag_thoughts_for_paths(
  p_project_id    uuid,
  p_changed_paths text[],
  p_signal_kind   text,
  p_detail        jsonb default '{}'::jsonb
)
returns table (thought_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with matched as (
    select t.id
    from public.thoughts t
    where t.project_id = p_project_id
      and (
        -- exact full-path overlap (GIN-indexed)
        t.paths operator(pg_catalog.&&) p_changed_paths
        -- directory-prefix match, only for pins that end in '/'
        or exists (
          select 1
          from pg_catalog.unnest(t.paths)         as pp
          cross join pg_catalog.unnest(p_changed_paths) as cp
          where pg_catalog.right(pp, 1) = '/'
            and pg_catalog.starts_with(cp, pp)
        )
      )
  ),
  ins as (
    insert into public.staleness_signals (thought_id, project_id, signal_kind, detail)
    select m.id, p_project_id, p_signal_kind, coalesce(p_detail, '{}'::jsonb)
    from matched m
    returning 1
  ),
  upd as (
    update public.thoughts t
    set stale_flagged_at = pg_catalog.now()
    from matched m
    where t.id = m.id
      and t.stale_flagged_at is null
    returning 1
  )
  select m.id from matched m;
end;
$$;

revoke all on function public.flag_thoughts_for_paths(uuid, text[], text, jsonb) from public;
grant execute on function public.flag_thoughts_for_paths(uuid, text[], text, jsonb) to service_role;

-- 5. flag_expired_thoughts: second producer (proves the interface is pluggable)
-- Flags not-yet-flagged thoughts whose expires_at has passed. Idempotent: the
-- `stale_flagged_at is null` guard means a steady-state run signals nothing.

create or replace function public.flag_expired_thoughts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with matched as (
    select t.id, t.project_id
    from public.thoughts t
    where t.expires_at is not null
      and t.expires_at < pg_catalog.now()
      and t.stale_flagged_at is null
  ),
  ins as (
    insert into public.staleness_signals (thought_id, project_id, signal_kind, detail)
    select m.id, m.project_id, 'expires_at_hit', pg_catalog.jsonb_build_object('expired', true)
    from matched m
    returning 1
  ),
  upd as (
    update public.thoughts t
    set stale_flagged_at = pg_catalog.now()
    from matched m
    where t.id = m.id
    returning 1
  )
  select pg_catalog.count(*) into v_count from matched;
  return v_count;
end;
$$;

revoke all on function public.flag_expired_thoughts() from public;
grant execute on function public.flag_expired_thoughts() to service_role;

-- 6. Clear-on-verify trigger --------------------------------------------------
-- When a human re-verifies (any UPDATE that advances last_verified_at, e.g.
-- mark_stale), drop the re-verification flag. security invoker + search_path=''
-- mirror public.set_updated_at (0001).

create or replace function public.clear_stale_flag_on_verify()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.last_verified_at is distinct from old.last_verified_at
     and new.last_verified_at is not null
     and (old.last_verified_at is null or new.last_verified_at > old.last_verified_at)
  then
    new.stale_flagged_at := null;
  end if;
  return new;
end;
$$;

create or replace trigger thoughts_clear_stale_flag_on_verify
  before update on public.thoughts
  for each row execute function public.clear_stale_flag_on_verify();

-- 7. Recreate match_thoughts to surface stale_flagged_at ----------------------
-- Body identical to 0017 (carries the freshness-decay ranking forward); the
-- only change is the new stale_flagged_at return column. Drop+recreate is
-- required to change the RETURNS TABLE shape, same as 0017. 768-dim deploys
-- swap vector(1536) -> vector(768) in the create signature, drop, and grant.

drop function if exists public.match_thoughts(
  extensions.vector(1536), int, float, uuid, public.thought_scope[], float, float, boolean
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
  stale_flagged_at  timestamptz,
  tags              text[],
  rank_score        float
)
language sql
security invoker
stable
set search_path = ''
as $$
  with candidates as (
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
      t.stale_flagged_at,
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
    c.stale_flagged_at,
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

grant execute on function public.match_thoughts(
  extensions.vector(1536), int, float, uuid, public.thought_scope[], float, float, boolean
) to authenticated;

commit;
