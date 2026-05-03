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

## Consequences

- The repo is a clean parallel repo. No upstream sync to track. Selectively port from OB1 by reading, not by `git pull`.
- License selection is open. Must be picked before any external collaborator commits.
- We own backups, TLS, upgrades, monitoring, and capacity planning for the Supabase stack on `pr.fabric-testbed.net`.
- Phase 1 schema and RLS work depends on a working GitHub OAuth flow on a scratch instance — Phase 0 includes that spike.
- CILogon support is a future addition, not a Phase 1 dependency. The repo structure (GoTrue config, RLS policies keyed off `auth.uid()`) accommodates either provider without rework.

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
