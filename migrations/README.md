# `migrations/` — TeamBrain schema evolution

Numbered SQL files that, applied in order via Studio's SQL editor, produce a working TeamBrain schema. Each file is forward-only and idempotent (safe to re-run); none drop data. See `docs/deployment.md` for the procedural detail (where to paste them, which advisor warnings are expected, how to verify each).

## The set

| # | File | Phase | Concern | Conditional? |
|---|---|---|---|---|
| 0001 | `0001_init.sql`              | 1   | Tables (`projects`, `project_members`, `thoughts`), ENUMs, indexes, `updated_at` trigger, `service_role` grants. **No RLS.** | always |
| 0002 | `0002_rls.sql`               | 1   | RLS on all 3 tables; `app.is_project_*` SECURITY DEFINER helpers; 8 policies (4 on `thoughts`, 2 on `projects`, 1 on `project_members`); `authenticated` table grants; `anon` revokes. | always |
| 0003 | `0003_disable_graphql.sql`   | 1   | `drop extension pg_graphql`. Transport surface lockdown — TeamBrain uses MCP + REST per ADR 0001. | always |
| 0004 | `0004_match_thoughts.sql`    | 2   | SECURITY INVOKER semantic-search RPC (`public.match_thoughts(...)`). RLS-aware (filters during the call rather than bypassing). | always |
| 0005 | `0005_resize_embedding_768.sql` | 2.5 | **Optional.** Resizes `thoughts.embedding` from `vector(1536)` to `vector(768)` for deployments choosing a self-hosted 768-dim provider (e.g. ollama + nomic-embed-text). Drops + recreates the HNSW index and `match_thoughts` for the new dim. | **Only for non-1536 providers** |
| 0006 | `0006_embedding_model.sql`   | 2.5 | Adds `thoughts.embedding_model text` + partial index. Operational complement to ADR 0001 § Decision 5: makes embedding-pipeline provenance observable so future provider/model swaps can scope re-embed passes. | always |
| —   | `seed.sql`                   | 1   | Hand-seeded pilot project + `project_members` rows. Resolved by GitHub handle from `auth.users.raw_user_meta_data`; gracefully skips users not yet logged in. Re-runnable. | always (apply last) |

## Apply order

```
0001  →  0002  →  0003  →  0004  →  [0005 if non-1536 dim]  →  0006  →  seed.sql
```

`0005` and `0006` can be reordered between themselves (both apply on top of 0004) but the canonical order is `0005` first so anyone tracing the file numbers reads them in the same sequence they apply in.

## Conventions enforced across all files

These come from `~/.claude/projects/.../memory/project_supabase_function_conventions.md` and Studio's Security Advisor:

- **Apply via Studio's SQL editor**, not `psql -U postgres`. The self-hosted `postgres` role is not a superuser and cannot own functions in `public`. Studio runs as `supabase_admin`, which is the correct DDL identity.
- **Extensions live in `extensions` schema**, never `public`. References in this directory's SQL use `extensions.vector`, `extensions.<=>`, etc.
- **Functions use `set search_path = ''`** with fully qualified references (e.g., `pg_catalog.now()` instead of bare `now()`). Required by Studio's "Function Search Path Mutable" check.
- **No `DROP TABLE`, `TRUNCATE`, or unqualified `DELETE`.** The CLAUDE.md hard boundary. `DROP POLICY IF EXISTS`, `DROP FUNCTION IF EXISTS`, and `DROP EXTENSION IF EXISTS` are allowed where re-runnability requires them.

## Adding a new migration

1. Pick the next number after the highest existing file (`0007`, `0008`, …).
2. Write a header comment block explaining: what phase the migration belongs to, why this concern is its own file (rather than folded into 0001-0006), and any conditional-apply rules.
3. Wrap the body in `begin; ... commit;` so failures don't leave a half-applied state.
4. Update this README's table.
5. Update `docs/deployment.md` if the new migration changes the apply procedure or adds env vars to the edge function.

## Baseline consolidation (deferred)

Pre-pilot iteration produced six numbered files that each represent the final state of their phase's concern (no fix-up migrations, no orphaned columns). At production cutover (Phase 6 / Phase 7 prep), the plan is to **freeze these as a `v1_baseline.sql` consolidation** and start a new migration lineage from `v1_001_*.sql`. Doing it now would force scratch to drift from a fresh deploy with no clean reconciliation; doing it at cutover lets the production-era migrations have a clean starting point while the per-phase set stays as the historical record.

This is recorded in `docs/phase-6-checklist.md` (when written) as a Phase 6 deliverable.
