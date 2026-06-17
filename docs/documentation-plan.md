# TeamBrain — Documentation Plan & Outline

A **skeleton + sequencing plan** for TeamBrain's user-facing documentation and
best-practices guidance. This is not the docs themselves — it's the structure to
fill in, plus *when* each piece should be written. Drafted 2026-05-30 (after
Phase 5 § C shipped).

> **Status legend:** ☐ not started · 🟡 provisional / living · ✅ done.

---

## Philosophy & timing (why this is staged, not written all at once)

Two forces pull in opposite directions:

1. **Onboarding needs docs *before* the Phase 7 pilot.** Real users (Komal et al.)
   can't be onboarded without a Getting Started guide — it's a pilot prerequisite.
2. **Best practices are *emergent*.** The pilot's whole job is to falsify
   assumptions (capture rate, retrieval hit rate, false-positive stale flags,
   friction, "AI told me wrong"). Carving best practices in stone before that
   evidence exists means documenting guesses.

So: write the **stable mechanics** early (they're settled), keep **best practices
as a living doc** seeded lean and hardened by pilot evidence, and don't write a
surface's guide until that surface exists.

### Readiness triggers — write each piece when its gate opens

| Doc piece | Write when | Why then |
|---|---|---|
| Getting Started (§ 1) | ✅ **shipped 2026-06-08** ([`getting-started.md`](getting-started.md)) | onboarding prerequisite; mechanics are settled |
| Best Practices (§ 2) | seed at Phase 7 kickoff (🟡), harden at Phase 7 wrap | needs pilot evidence to be authoritative |
| "Connect from every surface" reference (§ 3) | ✅ **unblocked 2026-06-15** — § B (Slack) + § D (slash commands) both shipped; not yet written | a "from any tool" guide is incomplete until all surfaces exist |
| Staleness + promotion best practices (§ 2.5, 2.6) | with **Phase 6** | can't document mechanisms that don't exist yet |
| Operator/admin docs (§ 4) | mostly **done** (`deploy/production/README.md`) | already covered; only needs an index entry |

---

## 1. Getting Started (end-user guide) — ✅ *[shipped 2026-06-08 — [`getting-started.md`](getting-started.md)]*

Audience: a developer who wants to read/write team memory from their AI tool.

1. **What TeamBrain is** — one paragraph + link to `docs/adr/0001`.
2. **Get access** — GitHub OAuth sign-in at `https://pr.fabric-testbed.net/`; how
   membership works (project_members; "empty results usually = not a member yet").
3. **Connect your AI tool** — copy-paste config per client:
   - Claude Code / Claude Desktop (remote MCP) · Cursor (MCP) · gemini-cli ·
     Copilot / VS Code · ChatGPT / OpenAI function calling (REST/OpenAPI).
   - ✅ Slack *[§ B]* · ✅ slash commands *[§ D]* (both shipped — Slack live since 2026-06-15, slash commands since 2026-06-09).
4. **The mental model**
   - **Scopes:** `personal` | `project` | `project_private` (who sees what).
   - **Types:** `decision | convention | gotcha | context | preference | runbook`.
   - **`project_slug`** (`owner/repo`) + the server default.
5. **Your first capture & search** — a 3-minute walkthrough.
6. **Where memory lives** — the hybrid model (in-repo canonical vs TeamBrain
   living) and the promotion loop; when to reach for which.
7. **Troubleshooting** — empty results (membership), 401 (expired JWT / renew),
   wrong project (slug), capture denied (writer role / scope).

## 2. Best Practices — 🟡 *[seed @ Phase 7 kickoff; authoritative @ Phase 7 wrap]*

Mark the whole doc **provisional/living** until pilot evidence lands.

1. **What's worth capturing** — durable, reusable team knowledge; *not* transient
   chatter or anything the repo already records (code, git history, CLAUDE.md).
2. **Writing a good memory** — self-contained, declarative ("X must Y because Z"),
   right scope + type, tags. *Seed examples mined from the dogfood corpus.*
3. **Capture discipline / avoiding pollution** — the human-approval gate; pruning;
   the "auto-proposer leaned to the 3-cap on a 1-line PR" lesson; confidence enum.
4. **Scope hygiene** — `personal` vs `project` vs `project_private` decision guide.
5. **Freshness & staleness** — ☐ *[Phase 6]* `last_verified_at`, `expires_at`,
   `confidence`, `mark_stale`; decay in ranking.
6. **Promotion to repo docs** — ☐ *[Phase 6]* when a memory stabilizes →
   `promote_to_docs` → ADR/docs PR (the governance loop).
7. **Provenance** — link `linked_commit_sha` / `linked_pr_url` / `linked_issue_url`.
8. **Auto-capture tuning** — proposal count, `TEAMBRAIN_APPROVERS`, dedup, model.
9. **Team governance** — review cadence, who curates, handling "AI told me wrong".

## 3. Reference: connect & capture from every surface — ☐ *[unblocked 2026-06-15 — § B + § D shipped; not yet written]*

- **MCP** — endpoint (`/functions/v1/teambrain-mcp/mcp`) + per-client config.
- **REST / OpenAPI** — `/openapi.yaml` + `examples/curl.md`.
- **GitHub Action** — `examples/github-actions/capture-on-merge.yml` (shipped § C);
  adoption guide [`capture-on-merge-adoption.md`](capture-on-merge-adoption.md)
  (written ahead of the rest of § 3 — the per-repo "add capture-on-merge" recipe).
- ✅ **Slack** *[§ B]* · ✅ **Slash commands** *[§ D]* (both shipped).
- **Non-interactive API tokens** — `teambrain-token` for CI/automation (shipped § A).

## 4. Operator / Admin — ✅ *(mostly exists)*

- Deploy + ops: `deploy/production/README.md`. Membership sync, backups,
  troubleshooting, upgrades. **Action:** add an index pointer from the user docs;
  no rewrite needed.

---

## Cross-cutting notes

- **Dogfood corpus = best-practices evidence seed.** The captures TeamBrain has
  accumulated about its own build (conventions, gotchas, milestones) are the first
  worked examples of good vs over-eager memories. Mine them when writing § 2.
- **Two homes for best practices, kept in lockstep:** machine-facing `AGENTS.md`
  (how/when an agent should capture, committed into pilot repos) and the
  human-facing Getting Started + Best Practices here. `AGENTS.md` is already a
  partial agent-best-practices seed.
- **Roadmap gap:** the Phased Roadmap has no explicit documentation deliverable —
  user docs are an *implicit* Phase 7 prerequisite. This plan makes it explicit.

## Definition of done (for the docs effort)

- A new contributor can connect their tool and make a useful capture from the
  Getting Started guide alone, without asking anyone.
- The Best Practices guide reflects **pilot evidence**, not pre-pilot assumptions.
- Every shipped capture surface (MCP, REST/Action, Slack, slash commands) has a
  connect recipe.
- Operator docs are linked, not duplicated.
