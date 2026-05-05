-- 0006_embedding_model.sql — track which model produced each embedding.
--
-- Apply via Studio SQL editor on every TeamBrain deployment, regardless
-- of which embedding provider was chosen. This migration is the
-- operational complement to ADR 0001 § Decision 5 (pluggable embedding
-- provider): without it, a future provider swap leaves Old vs. New
-- vectors mixed in the same column with no way to identify which is
-- which, and no way to scope a backfill.
--
-- The column stores a `<provider>:<model>` tag (e.g.
-- 'openai:text-embedding-3-small', 'ollama:nomic-embed-text'). The
-- edge function's capture path sets it from the same env vars that
-- drive `embedding.ts`, so it is always in sync with what just produced
-- the vector.
--
-- Intentionally NOT done by this migration:
--   * No backfill of existing rows. NULL means "captured before this
--     migration; model unknown". A re-embed pass against the current
--     provider will fill it in. Backfilling with an assumed default
--     would be a quiet lie if the assumption was wrong.
--   * No filter on `embedding_model` in `match_thoughts` or any tool.
--     A single deployment uses one model at a time; the tag is for
--     diagnostics and migration scoping, not runtime access control.

begin;

alter table public.thoughts
  add column if not exists embedding_model text;

comment on column public.thoughts.embedding_model is
  '<provider>:<model> tag identifying the embedding pipeline that produced the vector in `embedding`. NULL = pre-tagging-era row; re-embed to identify. See ADR 0001 Decision 5 + feedback_pgvector_model_tag.md.';

-- Partial index for diagnostic queries like:
--   select embedding_model, count(*)
--   from public.thoughts
--   where embedding_model is not null
--   group by 1;
-- Cheap because most deployments produce a single distinct value during
-- normal operation; the index becomes useful right around the moment a
-- provider switch creates two distinct values.
create index if not exists thoughts_embedding_model_idx
  on public.thoughts (embedding_model)
  where embedding_model is not null;

commit;
