# Phase 3 Checklist

Concrete, ordered tasks for Phase 3 — replace `seed.sql`'s hand-seeded `project_members` rows with an automated sync edge function that pulls the source-of-truth (GitHub repo collaborators + GitHub org-team membership) and reconciles `public.project_members` via `service_role`. Each item has an explicit **Done when** acceptance criterion.

Phase 3 entry preconditions (from `docs/phase-2-checklist.md` § L):

- ✅ `migrations/0004_match_thoughts.sql` applied; verification RPC returns 0 rows without error.
- ✅ MCP edge function deployed; 5 tools register and round-trip cleanly.
- ✅ Curl matrix passes; non-member isolation transitively established via Phase 1 § E3.
- ✅ `0006_embedding_model.sql` applied; embedding pipeline tags every capture.

If any are not green, finish Phase 2 / 2.5 first. Phase 3 assumes a working multi-tenant MCP surface and only changes how `project_members` rows get there.

---

## Architectural shape (the one-pager)

The `project_members` table currently has hand-seeded rows resolved by GitHub handle (Phase 1 `seed.sql`). That works for a 2-3 person pilot but doesn't scale and doesn't track changes (someone added as a collaborator on GitHub gets no `project_members` row until the next manual seed apply).

Phase 3 introduces an **edge function** that:

1. Reads the desired membership set from GitHub (the canonical source).
2. Reads the current membership set from `public.project_members`.
3. Computes a diff (adds, role changes, removes).
4. Applies the diff via `service_role` (the only role that can write `project_members` per Phase 1 § C: no policy permits `authenticated` to insert/update/delete).
5. Returns a structured report: which users were added/changed/removed, which were skipped (e.g. GitHub user has no `auth.users` row yet).

The function runs in two modes:

- **On-demand sync** (HTTP POST trigger, requires service-role auth or admin JWT). Useful for "I just added Komal as a collaborator on GitHub, sync now." Returns the diff.
- **Scheduled sync** (pg_cron, runs every N minutes). Reconciles drift in the background.

GitHub's API requires authentication. We use a **GitHub App installation token** for the FABRIC org rather than a personal access token — installation tokens are scoped per-org/per-repo, can be revoked without touching a developer's personal account, and have higher rate limits (5000/hr per installation vs 5000/hr per PAT for the same user across all repos).

---

## A — Decisions to lock before coding

### A1. Membership source — *resolved as "C-plus": team membership ∪ explicit direct grants*

(Note: this section originally described a *union* of all direct collaborators and all team members. Implementation against the real FABRIC org made the over-broad shape of that policy obvious — `affiliation=all` returned 15 collaborators where only the 5 SystemServicesTeam members were the intended TeamBrain audience. The policy refined to C-plus during the 2026-05-09 smoke session. ADR Decision 6 records the rationale.)

GitHub exposes three relevant slices of repo membership via the `affiliation` query parameter on `/repos/{owner}/{repo}/collaborators`:

| `affiliation=` | Returns |
|---|---|
| `outside` | Outside collaborators (non-org-members, added to the repo specifically) |
| `direct`  | Outside collaborators **+** org members with explicit per-repo grant |
| `all`     | Everything above **+** team-derived access **+** default-org-permission **+** owners |

Plus `GET /orgs/{org}/teams/{team_slug}/members` for the team roster.

**Shipped policy (C-plus):**

- If `projects.github_team_slugs` is empty → eligibility = `affiliation=all` collaborators. Suitable for projects without a curated team.
- If `projects.github_team_slugs` is non-empty → eligibility = (team members ∪ `affiliation=direct` collaborators). Default-org-permission access alone does NOT confer membership. The team is the policy lever; direct grants are an escape hatch for one-off contributors.
- **Role for an eligible user always comes from `affiliation=all`'s `permissions` object** (the effective per-user repo permission), regardless of how access was granted. This way `mjstealey` stays `admin` (his effective role) rather than getting a guessed default tied to whether the team has explicit repo grant.

Required schema change:

```sql
alter table public.projects
  add column if not exists github_team_slugs text[] not null default '{}';
```

**Done when:** `migrations/0007_projects_github_teams.sql` applied. The `fabric-testbed/fabric-core-api` row has `github_team_slugs = {systemservicesteam}` (confirmed 2026-05-10 against the actual FABRIC team in the screenshot at `~/Desktop/Screenshot 2026-05-09 at 8.26.12 PM.png`).

### A2. Role mapping: GitHub permission → TeamBrain `member_role`

GitHub collaborator permissions are: `pull` (read), `triage`, `push` (write), `maintain`, `admin`. TeamBrain `member_role` is `admin | contributor | reader`. Map:

| GitHub permission | TeamBrain role |
|---|---|
| `admin`            | `admin`       |
| `maintain`, `push` | `contributor` |
| `triage`, `pull`   | `reader`      |

Org-team members inherit the team's repo permission (queryable via the team-permission API or by joining team members against the collaborator list). Use the **higher** of (team-derived role, direct-collaborator role) when a user appears in both.

**Done when:** decision documented in the edge function header; the mapping is implemented as a single `mapGithubPermission(perm: string): MemberRole` function with an exhaustive switch.

### A3. Skipped vs. removed: handling users without `auth.users` rows

A GitHub collaborator who has never logged into the TeamBrain instance has no `auth.users` row. The handle-to-uuid resolution returns nothing for them. Two options:

| Option | Behavior |
|---|---|
| **Skip silently** | Don't create a `project_members` row; surface in the sync report as "N skipped (not yet logged in)". Their membership is only realized once they sign in. |
| **Pre-seed an "expected" record** | Create a placeholder somewhere so the system knows "this person *should* be a member once they log in." Adds a new table; complicates the model. |

**Recommendation: skip silently.** The first-login flow already triggers a sync (see I1 below), so the gap closes naturally without new state. The "N skipped" count in the sync report tells admins who's pending.

**Done when:** the function's `processCollaborators` step explicitly skips with-counter; no schema change required.

### A4. Authoritative removal: is the sync allowed to delete `project_members` rows?

If GitHub says someone is no longer a collaborator, should the sync delete their `project_members` row? Two reasonable positions:

1. **Yes, mirror exactly.** Sync = source of truth. Removed-from-GitHub → removed-from-TeamBrain. Memory access revoked instantly.
2. **No, sync only adds and updates.** Removal is an explicit admin action via a separate tool, to prevent "accidental revocation because someone misconfigured a GitHub team."

**Recommendation: yes, mirror exactly, but with a soft-delete option.** Add a `removed_at timestamptz` column to `project_members`; the sync sets it rather than DELETE'ing. RLS policies treat `removed_at IS NOT NULL` as not-a-member. Admins can restore by clearing `removed_at`. This is the audit-friendly path — we never lose history of "was once a member, removed at time X."

**Done when:** `migrations/0008_project_members_soft_delete.sql` adds `removed_at`, updates the `app.is_project_*` helpers to filter `removed_at IS NULL`, and the existing RLS policies continue to work without policy changes (since they go through the helpers).

### A5. GitHub auth: PAT vs. App vs. Action token?

| Option | Scope | Rate limit | Rotation cost |
|---|---|---|---|
| **Personal access token** (Michael's) | Whatever Michael has access to | 5000/hr shared with Michael's other use | Michael leaves, sync breaks |
| **GitHub App installed on fabric-testbed org** | Per-installation, scoped to selected repos/teams | 5000/hr per installation | Independent of any individual; revocable as a unit |
| **GitHub Action with `${{ secrets.GITHUB_TOKEN }}`** | Per-workflow | 1000/hr | Only available inside Actions, not from edge function |

**Recommendation: GitHub App.** Slight setup overhead (one-time), much better long-term posture. Installation token is fetched at sync time using a JWT signed by the app's private key, then used to call collaborator/team APIs. Token TTLs are 1h — fetched fresh each sync, no long-lived secret in the runtime.

**Done when:** a `TeamBrain Sync` GitHub App is registered against the `fabric-testbed` org with permissions: `Repository → Metadata: Read` (covers collaborators + repo-teams endpoints) and `Organization → Members: Read` (covers team-members endpoint; only required if any project has a non-empty `github_team_slugs`). `Repository → Members` does not exist as a permission — `Members` is org-scoped only. App ID + private key stored in the docker stack `.env` (gitignored). Function reads them at runtime to mint installation tokens.

### A6. Schedule cadence: how often does the background sync run?

| Cadence | Tradeoff |
|---|---|
| Every minute     | Closest-to-real-time, highest API budget burn |
| Every 5 minutes  | Acceptable lag; ~12 calls/hr per project |
| Every 15 minutes | Default; ~4 calls/hr per project |
| Hourly           | Conservative; first-login sync covers urgent cases |

**Recommendation: every 15 minutes by default**, with the on-demand HTTP endpoint covering urgent "I just added someone" cases. Configurable via a `projects.sync_interval_minutes` column if Phase 7 evidence shows we need finer control.

Use **`pg_cron`** (Supabase ships it) rather than an external cron — it's already in the stack, runs inside Postgres, and survives container restarts cleanly.

**Done when:** `migrations/0010_pg_cron_membership_sync.sql` schedules a `cron.schedule('teambrain-membership-sync', '*/15 * * * *', $$select net.http_post(...)$$)` that hits the edge function's scheduled endpoint.

---

## B — `migrations/0007_projects_github_teams.sql`

Adds `github_team_slugs text[]` to `public.projects`. No data backfill — set it manually for fabric-core-api after applying.

**Done when:**

```sql
select repo_slug, github_team_slugs from public.projects;
-- expect at least the fabric-core-api row, with github_team_slugs populated
-- after a manual update once the FABRIC team slug is confirmed.
```

---

## C — `migrations/0008_project_members_soft_delete.sql`

Adds `removed_at timestamptz` column. Updates the three `app.is_project_*` helpers to filter `removed_at IS NULL`. Updates the seed query to set `removed_at = NULL` on re-sync upserts. Does not touch RLS policies (they call the helpers, which are now soft-delete-aware).

**Verification:**

1. Existing rows have `removed_at IS NULL` (no migration data corruption).
2. A manually inserted row with `removed_at = now()` is invisible to RLS — `app.is_project_member()` returns false.
3. Restoring `removed_at = NULL` re-grants visibility.

**Done when:** the three checks pass via Studio SQL editor impersonation queries.

---

## D — Edge function: `edge-functions/teambrain-membership-sync/`

Same Hono + Deno pattern as `teambrain-mcp/`. Two endpoints:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /sync?project_slug=fabric-testbed/fabric-core-api` | service-role JWT or admin user JWT | On-demand sync for one project. Returns diff report. |
| `POST /sync-all` | internal-only (called by pg_cron with the service-role key) | Scheduled sync for every row in `public.projects`. Returns aggregate report logged to a new `sync_runs` table for observability. |

**Internal pipeline (one project):**

1. Resolve project_slug → `(project_id, github_team_slugs)`.
2. Mint a GitHub App installation token (cached for 50 min in module scope).
3. `GET /repos/{owner}/{repo}/collaborators` (paginated) → list of `(login, permission)`.
4. For each `team_slug` in `github_team_slugs`: `GET /orgs/{org}/teams/{team_slug}/members` → augment with team-derived permission.
5. Build the desired set: `{ login → role }` using the role mapping from § A2.
6. Resolve `login → auth.users.id` via the existing `raw_user_meta_data->>'user_name'` join. Skip + count entries with no auth row.
7. Compute diff against current `project_members` (filtering `removed_at IS NULL`).
8. Apply via service-role client: insert new, update changed roles, set `removed_at` for absent.
9. Return / log the report:

```json
{
  "project_slug": "fabric-testbed/fabric-core-api",
  "github_collaborators_seen": 7,
  "github_team_members_seen": 3,
  "added":   [{ "login": "alice",   "role": "contributor" }],
  "updated": [{ "login": "bob",     "old_role": "reader",      "new_role": "contributor" }],
  "removed": [{ "login": "charlie", "previous_role": "reader" }],
  "skipped_no_auth_row": [{ "login": "diane" }],
  "duration_ms": 432
}
```

**Done when:** running the sync against fabric-core-api with no GitHub-side changes returns `{ added: [], updated: [], removed: [], skipped_no_auth_row: [...] }` (the no-op case). Removing Komal as a collaborator on GitHub, then running sync, returns `removed: [{ login: "kthare10", previous_role: "contributor" }]` and her `project_members` row has `removed_at` set.

---

## E — `migrations/0009_sync_runs.sql` (observability)

Phase 3 introduces the first scheduled background work in TeamBrain. Without an audit log, "did the sync run?" is unanswerable. Add a small `sync_runs` table:

```sql
create table public.sync_runs (
  id           uuid        primary key default gen_random_uuid(),
  project_id   uuid        references public.projects(id) on delete set null,
  started_at   timestamptz not null default pg_catalog.now(),
  finished_at  timestamptz,
  ok           boolean,
  report       jsonb,
  error        text
);

alter table public.sync_runs enable row level security;
create policy sync_runs_select_admin on public.sync_runs
  for select to authenticated
  using (project_id is null or app.is_project_admin(project_id));
```

`service_role` writes; project admins read; everyone else is denied. Retention: keep 30 days, hand-prune later (no automated retention until size becomes a problem).

**Done when:** every invocation of the sync edge function produces a row; admin queries via PostgREST return them ordered by `started_at desc`.

---

## F — `migrations/0010_pg_cron_membership_sync.sql`

Schedules the `/sync-all` endpoint via `pg_cron`. Requires `pg_net` for the HTTP call (Supabase ships both).

```sql
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

select cron.schedule(
  'teambrain-membership-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.teambrain_sync_url'),
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{}'::jsonb
  );
  $$
);
```

`current_setting('app.teambrain_sync_url')` and `current_setting('app.service_role_key')` are session-level GUC variables set via `alter database ... set app.X = '...'` once at deploy. Keeps the secrets out of `cron.job` table, which is queryable.

**Done when:** `select * from cron.job` shows the schedule; `select * from public.sync_runs order by started_at desc limit 5` shows runs every ~15 min.

---

## G — Smoke test matrix

After all migrations + edge function are deployed:

| # | Action | Expected | Status (2026-05-10) |
|---|---|---|---|
| 1 | Run on-demand sync against fabric-core-api with no changes | `{ added:[], updated:[], removed:[], skipped_no_auth_row:[…] }`; existing seeded membership unchanged. | ✅ Green |
| 2 | A team member without an `auth.users` row appears in the report | Login lands in `skipped_no_auth_row`. | ✅ Green (4 entries on first sync: sajith, ibaldin, kthare10, yaxue1123) |
| 3 | Have a skipped user sign in via OAuth, then re-run sync | That user moves from `skipped_no_auth_row` to `added` with mapped role. | ⏳ Waits on Komal's first OAuth login on `https://127.0.0.1:8443` |
| 4 | Demote a member's GitHub permission (admin → maintain); re-sync | Member appears in `updated` with `old_role: admin, new_role: contributor`. | ⏸️ Skipped (would mutate a real teammate's GitHub permissions on prod) |
| 5a | Remove someone from `SystemServicesTeam`; re-sync | Member drops from `skipped_no_auth_row` (if they had no auth row) **or** appears in `removed` with `removed_at` set (if they had a `project_members` row). | ✅ Green for the no-auth-row branch (sajith removed cleanly 2026-05-10 19:57Z); ⏳ tombstone branch awaits Komal logging in |
| 5b | Add the removed member back to `SystemServicesTeam`; re-sync | If they had a tombstoned row: `restored` event, `removed_at` cleared. | ⏳ Same prereq as 5a tombstone branch |
| 6 | (folded into 5b) |  |  |
| 7 | Wait 15 minutes for the scheduled pg_cron run | New row appears in `public.sync_runs` for the aggregate run. | ⏸️ Production-only (0010 not applied on scratch) |

Steps 4 and 5-tombstone are the load-bearing steps — they prove revocation flows from GitHub through to RLS in real time. Today both are blocked on having a second active human (Komal) in `project_members`, which itself blocks on her one-time OAuth login. The eligibility-filter half of step 5 (sajith case) was exercised cleanly and proves the GitHub → eligibility → diff chain.

**Done when:** all 7 steps pass; the `seed.sql` file becomes vestigial (still useful for fresh deploys before the sync runs once, but no longer the primary membership-management path).

---

## H — Docs + commit

### H1. Update `docs/deployment.md`

Add a Phase 3 section: GitHub App setup procedure, env vars (`TEAMBRAIN_GITHUB_APP_ID`, `TEAMBRAIN_GITHUB_APP_PRIVATE_KEY`, `TEAMBRAIN_SYNC_URL`), pg_cron + pg_net extensions, GUC settings.

### H2. Update `migrations/README.md`

Add 0007–0010 to the migration table; clarify that 0007 + 0008 are **always** applied, 0009 + 0010 are needed only for production scheduled-sync (a scratch instance can run on-demand sync only and skip pg_cron).

### H3. ADR follow-up

Add a Decision 6 to `docs/adr/0001-teambrain-architecture.md` documenting the GitHub App + soft-delete choices. Phase 3's two non-obvious decisions (App vs. PAT, soft-delete vs. hard-delete) deserve permanent record.

### H4. Commit

```bash
git add migrations/0007_projects_github_teams.sql \
        migrations/0008_project_members_soft_delete.sql \
        migrations/0009_sync_runs.sql \
        migrations/0010_pg_cron_membership_sync.sql \
        edge-functions/teambrain-membership-sync/ \
        docs/phase-3-checklist.md \
        docs/deployment.md \
        docs/adr/0001-teambrain-architecture.md \
        migrations/README.md
git commit -m "Phase 3: automated GitHub-collaborator membership sync"
git push personal main
```

---

## I — Phase 4 readiness gate

Before moving to Phase 4 (REST + OpenAPI surface):

- [x] B — `0007_projects_github_teams.sql` applied; fabric-core-api has `github_team_slugs = {systemservicesteam}` (2026-05-10).
- [x] C — `0008_project_members_soft_delete.sql` applied; helpers updated; behavior verified via the mjstealey tombstone/restore cycle during the 2026-05-09 over-broad-sync incident.
- [x] D — edge function `teambrain-membership-sync` deployed to scratch; on-demand `/sync` returns well-formed diff reports; role-of-truth and eligibility-filter behavior confirmed against the real org.
- [x] E — `0009_sync_runs.sql` applied; three audit rows now present (2026-05-10 00:53 / 19:56 / 19:57) with matching jsonb reports.
- [ ] F — `0010_pg_cron_membership_sync.sql` applied. **Deferred to production deploy** — scratch uses on-demand `/sync` only.
- [ ] G — smoke matrix steps 1, 2, 5a green. Steps 3, 5-tombstone, 5b block on Komal's first OAuth login; step 4 deferred (prod-GitHub mutation risk); step 7 production-only.

If green, Phase 4 (REST/OpenAPI surface mirroring the MCP tools) can begin. The MCP transport is feature-complete from a membership-management perspective; Phase 4+ is parallel transport surface, not new authoritative behavior.

---

## J — Open follow-ups not blocking Phase 3

- **First-login sync trigger.** When a user completes GitHub OAuth for the first time, we want their `project_members` row to materialize without waiting up to 15 minutes for the next scheduled sync. Easiest: a GoTrue webhook → the on-demand sync endpoint, scoped to projects where the new user's GitHub handle appears in any tracked repo's collaborators. Defer to Phase 3.5 if it doesn't fall out naturally from the main work.
- **Rate-limit observability.** GitHub's `X-RateLimit-Remaining` header should be logged into `sync_runs.report` so we notice when we're approaching the 5000/hr ceiling before it bites. Add as a small enhancement during D.
- **Multi-org pilot.** TeamBrain is currently single-org (fabric-testbed). If a pilot adopter uses multiple orgs, the GitHub App needs to be installed per-org. Phase 3 ships single-org-aware; Phase 8+ revisits if demand emerges.

---

## Notes for the next session

- Read order: `CLAUDE.md` → `docs/adr/0001-teambrain-architecture.md` → `docs/phase-2-checklist.md` (for the MCP transport context) → this file.
- Phase 3's edge function is **not** a tool surface — it's a backend reconciler triggered via HTTP or pg_cron. Don't add MCP tools to it.
- Service-role usage is acceptable here (and only here) because membership writes have no policy permitting `authenticated`. The MCP edge function from Phase 2 should never call into Phase 3's service-role-only paths.
- Decisions and blockers go to Open Brain with prefix `PROJECT: TeamBrain — `.
