-- 0014_thoughts_linked_pr_url_index.sql — Phase 6 (deferred-paydown):
-- partial index on thoughts.linked_pr_url to support exact PR-merge dedup
-- and Phase 6 staleness-by-PR.
--
-- Apply via Studio SQL editor after 0013. Safe on any stack.
--
-- Background:
--   The Phase 5 § C capture-on-merge Action dedups by scanning recent thoughts
--   for a deterministic `owner/repo#N` tag (C-D7) because the REST read surface
--   did not filter on `linked_pr_url`. That misses a re-run once the original
--   capture scrolls out of the recent window. Adding a `linked_pr_url` filter to
--   GET /thoughts (edge-function change, separate from this file) makes dedup
--   exact; this index keeps that lookup — and the eventual Phase 6
--   "flag thoughts whose linked PR changed" pass — from seq-scanning as the
--   table grows.
--
-- Partial (WHERE linked_pr_url IS NOT NULL): the column is sparse — only
-- PR-provenanced captures set it — so the index stays small and only covers
-- the rows the lookups actually target.

begin;

create index if not exists thoughts_linked_pr_url_idx
  on public.thoughts (linked_pr_url)
  where linked_pr_url is not null;

commit;

-- Verification (read-only):
--
--   select indexname from pg_indexes
--   where tablename = 'thoughts' and indexname = 'thoughts_linked_pr_url_idx';
