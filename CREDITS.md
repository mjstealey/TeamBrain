# Credits

## OB1 (Open Brain)

TeamBrain is a multi-tenant adaptation of architectural patterns from [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1), created by [Nate B. Jones](https://natesnewsletter.substack.com/) and the Open Brain community.

### What we ported

- **Row Level Security patterns** — adapted from OB1's [`primitives/rls/`](https://github.com/NateBJones-Projects/OB1/tree/main/primitives/rls) into TeamBrain's `personal | project | project_private` scope model with `project_members`-based access.
- **Shared MCP edge-function pattern** — adapted from OB1's [`primitives/shared-mcp/`](https://github.com/NateBJones-Projects/OB1/tree/main/primitives/shared-mcp) into a multi-tenant, project-aware tool surface.
- **Supabase + pgvector + Edge Functions stack choice** — same foundational architecture as documented in OB1's [`docs/01-getting-started.md`](https://github.com/NateBJones-Projects/OB1/blob/main/docs/01-getting-started.md).

### What we did not port

- The single-user `thoughts` table shape (we extended it with `project_id`, `scope`, `type`, provenance, freshness, `paths[]`, `confidence`, and `tags`).
- OB1's contribution model and PR review automation (TeamBrain is a team-internal tool, not a community-contribution platform).
- OB1's extensions, recipes, dashboards, and skill packs — those target single-user personal productivity, which is a different problem.

### Why a parallel repo, not a fork

OB1 is licensed under FSL-1.1-MIT, which prohibits commercial derivative works. TeamBrain may eventually become shared infrastructure or a product, and we wanted that license choice to remain open. We also wanted to evolve the schema and contribution model without philosophical tension with the upstream project, which targets single-user personal productivity. The full decision rationale is captured in the project's Open Brain memory under `PROJECT: TeamBrain — Decision: parallel repo (not fork of OB1)`.

OB1's code is read-only reference for this project. We do not vendor or copy OB1 source into this repo; we port the patterns and credit the source here.
