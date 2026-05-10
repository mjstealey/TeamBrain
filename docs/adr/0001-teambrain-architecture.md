# ADR 0001: TeamBrain Architecture — Parallel Repo, Self-Hosted Supabase, GitHub OAuth Phase 1

- **Status:** Accepted
- **Date:** 2026-05-02
- **Deciders:** Michael Stealey
- **Related:** Open Brain memory entries prefixed `PROJECT: TeamBrain — ` (4-part plan from 2026-04-22; decisions captured 2026-05-02 for parallel-repo and self-host+GitHub-OAuth)

## Context

TeamBrain is a multi-tenant, project-scoped, AI-agnostic shared memory service for development teams, built on the architectural patterns originally established in [OB1 (Open Brain)](https://github.com/NateBJones-Projects/OB1). Before any Phase 1 schema work, four architectural decisions had to be locked in:

1. Repo relationship to OB1 — fork vs. parallel
2. Stack — managed Supabase vs. self-hosted vs. roll-your-own
3. Deploy target — cloud vs. team-owned hardware
4. Auth provider — GitHub OAuth vs. CILogon OIDC

This ADR captures all four together because they are coupled — each constrains the others.

## Decision 1 — Parallel repo, not a fork

**Decision:** Stand up TeamBrain as a parallel repo at `~/GitHub/mjstealey/TeamBrain/` with a `CREDITS.md` acknowledging OB1 and the patterns ported from it. Do **not** fork OB1.

### Considered alternatives

- **Fork OB1.** Was the original Part 4 plan recommendation ("keeps upstream improvements pullable").
- **Parallel repo with selective port.** Chosen.

### Rationale

The "pull upstream improvements via `git pull upstream main`" benefit of forking is highest when both repos track the same problem. OB1 targets single-user personal productivity; TeamBrain targets multi-tenant team infrastructure. The two diverge fast.

Concrete cons of forking that decided the call:

- **License inheritance.** OB1 is licensed under FSL-1.1-MIT, which prohibits commercial derivative works. TeamBrain may eventually become shared infrastructure or a product; we want license selection to remain open.
- **Repo baggage.** OB1 ships ~10 community skill packs, household-knowledge / meal-planning extensions, and recipes targeting personal productivity. None of that fits a team-internal tool.
- **Contribution conventions.** OB1 enforces `[category]` PR titles and `metadata.json` per contribution — appropriate for a community-contribution platform, not a team-internal service.
- **Schema philosophy.** OB1's `thoughts` table is single-user; TeamBrain extends it with project scoping. Adding columns is allowed by OB1's rules, but the upstream design ethos is opposite to TeamBrain's, creating ongoing merge friction.

The two OB1 patterns TeamBrain actually needs — `primitives/rls/` and `primitives/shared-mcp/` — port in under a day. We acknowledge the source in `CREDITS.md` and treat the OB1 clone at `~/github/mjstealey/OB1/` as read-only reference.

## Decision 2 — Self-host the official Supabase docker-compose stack

**Decision:** Run the official [Supabase docker-compose stack](https://github.com/supabase/supabase/tree/master/docker) on team-owned hardware. Do not use managed Supabase; do not roll a custom Postgres + FastAPI stack.

### Considered alternatives

- **Path A — Official Supabase docker-compose.** Chosen.
- **Path B — Lighter custom stack** (Postgres+pgvector + FastAPI MCP server + Authlib OIDC, drop Studio/PostgREST/Realtime/Storage/Kong/GoTrue). Tempting because the FABRIC team is Python-shop, but rejected.
- **Path C — Kubernetes** (OB1 has [`integrations/kubernetes-deployment/`](https://github.com/NateBJones-Projects/OB1/tree/main/integrations/kubernetes-deployment) by `@velo`). Overkill for a single VM.

### Rationale

Path B's "team is Python-shop" argument was overstated. The Deno edge function for the MCP server is ~200 lines of TypeScript — a bounded, isolated component, not a stack-wide commitment. Migrations are SQL, schema design is SQL, companion services (Slack capture, GitHub Action, OpenAPI clients) can stay Python.

What Path B would have forced TeamBrain to rebuild:

- **Studio** — admin UI for browsing/editing data, running SQL, viewing logs, managing auth.
- **GoTrue** — handles OAuth (GitHub + Google + ~25 others), OIDC (CILogon plugs in as a custom provider), magic links, JWT issuance, refresh tokens.
- **PostgREST** — auto-generated REST API from the schema.
- **Supabase CLI** — migrations, seeding, type generation, local-dev shadow DB.
- **Upgrade discipline** — Supabase ships coordinated docker-compose version bumps; on Path B we'd track ~5 components separately.

The recurring cost of reinventing those wheels is real. Path A absorbs it.

Path C is a future option if TeamBrain ever scales beyond a single VM.

## Decision 3 — Deploy on team-owned hardware at `pr.fabric-testbed.net`

**Decision:** Deploy on a FABRIC-team-owned VMware VM at the public hostname `https://pr.fabric-testbed.net`. Reverse proxy via Caddy (preferred) or nginx, TLS via Let's Encrypt.

### Rationale

- **Data sovereignty / cost.** Team owns the hardware and the data. No managed-service per-row pricing or vendor lock-in.
- **VM availability.** The FABRIC team has long-lived VMware VM capacity already.
- **Public IP.** `pr.fabric-testbed.net` is already publicly addressable, which simplifies network access for developers' AI tools (no VPN required for MCP traffic).
- **Operational fit.** The FABRIC team already operates Postgres, docker-compose, OIDC, and vouch-proxy in production for `fabric-core-api` and `cilogon-vouch-proxy-example`. Self-host operational burden is low because the muscle exists.

VM sizing target: 4 vCPU / 8 GB RAM / 50 GB disk; bump RAM if loading large embedding sets. Backups via nightly `pg_dump` + offsite copy for v1; pgBackRest/Barman if PITR becomes required.

Studio is gated behind vouch-proxy + CILogon (reusing the FABRIC pattern), even though application-level auth is GitHub OAuth — admin operations align with the team's existing CILogon SSO.

## Decision 4 — GitHub OAuth for Phase 1; CILogon deferred

**Decision:** Phase 1 auth uses GitHub OAuth via GoTrue. `project_members` rows are hand-seeded for the pilot (~3 devs). Phase 3 automates membership sync against GitHub collaborator and org-team APIs. CILogon support is deferred — GoTrue can run both providers simultaneously, so adding CILogon later is non-breaking.

### Considered alternatives

- **GitHub OAuth only (Phase 1).** Chosen.
- **CILogon OIDC only (Phase 1).**
- **Both, simultaneously, from Phase 1.** Rejected — over-engineered for pilot scope.

### Rationale

All FABRIC developers already authenticate with GitHub daily. GitHub is the source of truth for repo collaborator lists, which is exactly the membership signal `project_members` needs.

CILogon would be the right call when **any** of these becomes true:

- Non-GitHub collaborators (researchers from partner institutions without GitHub accounts) need access.
- Compliance audit requires institutional identity per access event.
- TeamBrain expands beyond developer audiences (e.g., a FABRIC researcher knowledge base).

None apply to Phase 1. GoTrue supports CILogon as a custom OIDC provider, so we can add it as a second login button later without breaking GitHub auth.

### Important nuance — claims model

GitHub OAuth does **not** put membership claims in the JWT. What it provides:

- **Identity (in the token):** stable GitHub user ID (`sub`), username, email, name.
- **Authorization (via API call with stored access token):** scopes (`read:user`, `user:email`, `read:org`, optionally `repo`/`public_repo`) determine what the access token can fetch.

The Phase 3 membership sync edge function reads collaborator/org-team membership via the GitHub API and upserts `project_members` rows. RLS policies on `thoughts` then enforce access using `auth.uid()` against `project_members`.

For Phase 1 pilot, `project_members` rows are hand-seeded — auth stays GitHub OAuth from day one, but membership is hand-maintained. This matches the original Phase 1 plan ("manual user seeding") and lets Phase 1 stay schema-focused.

## Decision 5 — Pluggable embedding provider; OpenAI default, self-host as deploy-time variant

(Resolved 2026-05-05. Replaces an "Open Decision" entry that was open for ~hours during the same Phase 2 review session.)

### Context

Phase 2's MCP edge function originally hard-coded OpenAI `text-embedding-3-small` (1536 dims, matching the `thoughts.embedding vector(1536)` column inherited from OB1). Once the Phase 2 build made that implicit choice visible, three problems with it were obvious for a multi-tenant team service: a personal-account API key paying for team-wide usage, every captured thought's content transiting a third-party vendor's servers (a compliance posture mismatch with FABRIC's existing research-infra norms), and TeamBrain availability coupling to OpenAI rate limits and uptime.

But a forced switch to self-hosted embeddings was not the right answer either: other teams adopting TeamBrain may have legitimate reasons to pay for OpenAI quality (its embeddings are still state-of-the-art for many domains), and forcing them onto a smaller open model would be presumptuous.

### Decision

The embedding provider is **pluggable at deploy time** via an `EMBEDDING_PROVIDER` environment variable consumed by the edge function. Two providers are shipped in-repo; teams can add more by writing a new dispatch arm:

| `EMBEDDING_PROVIDER` value | Backend | Dim | Default for |
|---|---|---|---|
| `openai`                   | `https://api.openai.com/v1/embeddings`, model `text-embedding-3-small` | 1536 | scratch / dev / teams choosing OpenAI |
| `ollama`                   | sidecar ollama container, model `nomic-embed-text`                      | 768  | `pr.fabric-testbed.net` production |

The pgvector column dimension is fixed at `create table` time and cannot vary per row. Each TeamBrain *deployment* therefore picks one provider and applies the matching schema variant before any thoughts are captured. `migrations/0001_init.sql` ships with the `vector(1536)` default; `migrations/0005_resize_embedding_768.sql` is an optional one-shot for deployments choosing ollama (or any other 768-dim provider). Mixing providers within one deployment is not supported.

Switching providers post-data requires re-embedding every existing thought against the new model. This is a documented operational cost, not a code feature — the design deliberately makes it visible rather than papering over it with provider-shim layers that quietly produce subtly wrong rankings.

### Consequences

- The FABRIC production deployment runs ollama, paying zero per-request cost and keeping all captured-thought content inside the FABRIC perimeter.
- Other teams adopting TeamBrain pick at deploy time; the README and `docs/deployment.md` document both paths symmetrically.
- The migration set is asymmetric (no `0005` for the OpenAI path; one `0005` for the ollama / 768-dim path) but this matches reality: most teams pick the default and never see migration `0005`.
- Future providers (Cohere 1024, Voyage 512, etc.) are added by a deploying team writing their own resize migration following the `0005_resize_embedding_768.sql` template — no per-provider shipped variant needed for completeness.
- Migration `0006_embedding_model.sql` (applied by every deployment, regardless of variant) adds a `thoughts.embedding_model` column tagged `<provider>:<model>` on every capture. The tag is the load-bearing complement to the pluggable provider — without it, a future provider or model swap leaves Old vs. New vectors mixed in the same column with no way to identify which is which, and search results just feel "off" with no clean diagnostic path. With it, re-embed passes are scoped (`update ... where embedding_model != $current_model`) and the mix is observable (`select embedding_model, count(*) from thoughts group by 1`). The tag is set by the edge function's capture path from the same env vars that drive `embed()`, so it cannot drift from the pipeline that just produced the vector.

## Decision 6 — Phase 3 membership sync: GitHub App, soft-delete, team-as-policy

(Resolved 2026-05-09 / 2026-05-10. Replaces the original Phase 3 sketch in `docs/phase-3-checklist.md` § A1/A4/A5, where the membership source was described as a *union* of direct collaborators and team members. The shipped policy is meaningfully different.)

### Context

Phase 3 replaces `seed.sql`'s hand-seeded `project_members` rows with an edge function (`teambrain-membership-sync`) that reconciles membership against GitHub. The original design left three sub-decisions deferred until implementation made the tradeoffs visible: how to authenticate against the GitHub API, what to do when a member is removed, and whose roster counts as the source of truth.

Smoke-testing on the FABRIC scratch instance against `fabric-testbed/fabric-core-api` clarified each:

1. The repo has **no explicit direct collaborators** in the GitHub sense (`affiliation=direct` returns zero). All 15 effective collaborators access via a combination of org-default permission and team-derived grants.
2. The org *does* have a named team — `SystemServicesTeam` — that is the natural curated subset of "people who should have TeamBrain access" (a 5-person superset of the pilot).
3. The original "union" model would have over-included the 10 non-team collaborators (org-default-permission grants), turning the sync into an over-broad "everyone in the org" pull rather than a curated team membership.

### Decision

Three coupled choices encoded in `edge-functions/teambrain-membership-sync/` and migrations `0007`–`0010`:

**GitHub App (not a PAT) for authentication.** Installation tokens are minted per-sync from a short-lived (~9 min) RS256-signed app JWT. Installation tokens TTL ~1 h; cached in worker memory and refreshed 5 min before expiry. The private key lives only in the runtime container's env, scoped to a single installation against a specific repo set. The dev/scratch and production stacks each register their own App against the same org so a laptop compromise does not grant prod access (`docs/deployment.md` § "Scratch vs production").

**Soft-delete via `removed_at timestamptz` (not DELETE).** Migration `0008_project_members_soft_delete.sql` adds the column; the three `app.is_project_*` RLS helpers absorb the tombstone filter, so existing policies stay untouched. The sync sets `removed_at = now()` when GitHub says someone is no longer a member, and clears it on re-add (reported as `restored` in the diff). Rollback from a bad sync is always an UPDATE — no audit-history loss, no row-recovery procedure to document. The blast-radius-containment value justifies the column for the lifetime of the table.

**C-plus eligibility: team membership ∪ explicit direct grants.** The shipped policy:

- If `projects.github_team_slugs` is empty → eligibility = `affiliation=all` collaborators (the original behavior, suitable for projects without a curated team).
- If `projects.github_team_slugs` is non-empty → eligibility = (team members ∪ `affiliation=direct` collaborators). Default-org-permission access alone does *not* confer TeamBrain membership.
- Role for an eligible user is always the *effective* repo permission from `affiliation=all` (so role mapping reflects what GitHub actually grants, not a guessed default tied to team-repo grants).

The semantic is "explicit GitHub action required" — onboarding to TeamBrain means either being added to a named team or being granted direct repo access. Default org permission, which often grants every org member read on every repo, is intentionally insufficient. This degrades cleanly to "team-only" when no direct grants exist (today's FABRIC state), but does not require a code change the first time a one-off external contributor is added directly to the repo.

### Consequences

- `fabric-testbed/fabric-core-api` is configured `github_team_slugs = {systemservicesteam}`. Membership tracks the 5 (now 4, after smoke-test cleanup of an inactive member) SystemServicesTeam members.
- The `app.is_project_*` helpers each filter `removed_at IS NULL`. Any future RLS-touching code that introduces a *new* membership predicate must remember to do the same — captured as a "things to know" hazard for anyone editing `migrations/0002_rls.sql` or `0008_project_members_soft_delete.sql`.
- Two GitHub Apps must be registered per pilot org (dev + prod), each installed separately. Operationally simple but doubles the App-management surface.
- Sync invocations are audit-logged in `public.sync_runs` (jsonb `report`, admin-scoped RLS). Step 7 of the Phase 3 smoke matrix (pg_cron scheduled run) is production-only; everything else is verified on scratch (`docs/phase-3-checklist.md` § G).
- The original checklist's "union" model is superseded — `docs/phase-3-checklist.md` § A1 reflects the C-plus shape. The original union semantics are recoverable for any project that wants them by leaving `github_team_slugs` empty.

## Consequences

- The repo is a clean parallel repo. No upstream sync to track. Selectively port from OB1 by reading, not by `git pull`.
- License selection is open. Must be picked before any external collaborator commits.
- We own backups, TLS, upgrades, monitoring, and capacity planning for the Supabase stack on `pr.fabric-testbed.net`.
- Phase 1 schema and RLS work depends on a working GitHub OAuth flow on a scratch instance — Phase 0 includes that spike.
- CILogon support is a future addition, not a Phase 1 dependency. The repo structure (GoTrue config, RLS policies keyed off `auth.uid()`) accommodates either provider without rework.
- Issue-tracker integration (Plane, GitHub Issues, or other) is deliberately **not** a pre-pilot deliverable. The Phase 7 pilot is the falsifier for whether time-based staleness signals (`last_verified_at`, `expires_at`, `confidence`, commit-triggered webhook in Phase 6) are sufficient on their own. Integrating an issue-tracker oracle before that evidence exists would presuppose the answer. Phase 6 staleness work designs the signal interface to be pluggable so a future integration can drop in as a Phase 8 candidate without refactoring.

## References

- OB1 repository: <https://github.com/NateBJones-Projects/OB1>
- OB1 RLS primitive: <https://github.com/NateBJones-Projects/OB1/tree/main/primitives/rls>
- OB1 shared-mcp primitive: <https://github.com/NateBJones-Projects/OB1/tree/main/primitives/shared-mcp>
- OB1 K8s self-host integration: <https://github.com/NateBJones-Projects/OB1/tree/main/integrations/kubernetes-deployment>
- Supabase docker-compose: <https://github.com/supabase/supabase/tree/master/docker>
- Supabase social-login docs (GoTrue providers, including custom OIDC): <https://supabase.com/docs/guides/auth/social-login>
- MCP specification: <https://modelcontextprotocol.io>
- Local FABRIC vouch-proxy + CILogon reference: `~/github/fabric/cilogon-vouch-proxy-example`
- Local FABRIC Python service reference: `~/github/fabric/fabric-core-api`
