-- 0020_thoughts_promoted_pr_url.sql — Phase 6 § D (promote_to_docs → real PR):
-- record the docs/ADR PR a thought was promoted into.
--
-- Apply via Studio SQL editor after 0019. Safe on any stack.
--
-- Background:
--   Phase 6 § D turns `promote_to_docs` from a preview stub into a real action:
--   it generates an ADR-style markdown file from a thought, opens a PR in the
--   project's repo via the TeamBrain GitHub App, and — on success — stamps the
--   source thought so the promotion is visible and idempotent.
--
--   `promoted_pr_url` is that back-link. It serves three purposes:
--     1. Provenance — the thought now points at the reviewed doc it graduated
--        into, the inverse of `linked_pr_url` (which points at the PR a thought
--        was captured *from*).
--     2. Idempotency — a re-promote of an already-promoted thought short-circuits
--        and returns the existing PR instead of opening a duplicate.
--     3. Surfacing — list_recent / GET /thoughts return it, so a reader can
--        tell at a glance which memories have been promoted. (Search via
--        match_thoughts is not extended here; a promoted thought is also
--        confidence='confirmed', which search already returns.)
--
--   The companion `confidence := 'confirmed'` stamp is set by the edge function
--   (not here) on the same successful-promote path: promotion is a strong human
--   signal that the memory has stabilized. That write goes through RLS as the
--   promoting writer, so no policy change is needed — the existing
--   `thoughts_update_self_or_writer` policy already permits it.
--
-- No index: the column is read by id (the promote path already has the row) and
-- as a passthrough in list/search projections; it is not a filter predicate, so
-- a partial index (cf. 0014's linked_pr_url) would not pay for itself here.

begin;

alter table public.thoughts
  add column if not exists promoted_pr_url text;

comment on column public.thoughts.promoted_pr_url is
  'URL of the docs/ADR PR this thought was promoted into via promote_to_docs '
  '(Phase 6 § D). NULL = not yet promoted. Set by teambrain-mcp/teambrain-rest '
  'on a successful promotion (alongside confidence := ''confirmed''); a non-NULL '
  'value makes a re-promote idempotent. Inverse of linked_pr_url.';

commit;

-- Verification (read-only):
--
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'thoughts'
--     and column_name = 'promoted_pr_url';
--   -- expect: promoted_pr_url | text | YES
