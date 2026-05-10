-- 0007_projects_github_teams.sql — Phase 3 prerequisite: record which
-- GitHub teams (if any) a project syncs membership against.
--
-- Apply via Studio SQL editor on the scratch instance, after 0001-0006.
--
-- Background:
--   Phase 3 introduces an automated GitHub-collaborator membership sync.
--   The sync's input is a UNION of two GitHub API endpoints:
--
--     1. GET /repos/{owner}/{repo}/collaborators
--          — direct collaborators on the repo.
--     2. GET /orgs/{org}/teams/{team_slug}/members
--          — members of an org-level team that has been granted access
--            to the repo.
--
--   For `fabric-testbed/fabric-core-api` both apply. We need a per-project
--   way to record the team(s) — repo_slug alone tells us the org+repo,
--   but not which team(s) feed the repo's membership at the org layer.
--
-- What this migration does:
--   * Adds `github_team_slugs text[]` to `public.projects`.
--   * Defaults to '{}' so existing rows stay valid; the sync function
--     interprets empty as "consume direct collaborators only, no team
--     pull". Population is a manual `update` once FABRIC ops confirms
--     the team slug — held outside this file so the structural change
--     and the data fact are independently re-applyable.
--
-- What this migration does NOT do:
--   * No backfill of `github_team_slugs` for any existing project. Run
--     the verification query at the bottom, then manually update the
--     fabric-core-api row once the team slug is known. A new row
--     can ship with an explicit `github_team_slugs` value at insert
--     time.
--   * No grants change. `authenticated` already has SELECT on
--     `public.projects` from 0002, and the new column inherits that
--     grant automatically. `service_role` already has full DML.

begin;

alter table public.projects
  add column if not exists github_team_slugs text[] not null default '{}';

comment on column public.projects.github_team_slugs is
  'GitHub org-team slugs to UNION with direct repo collaborators when computing project membership. Empty array means direct-collaborators-only.';

commit;

-- Verification (read-only, safe to re-run):
--
--   select repo_slug, github_team_slugs
--   from public.projects
--   order by repo_slug;
--
-- Expected after first apply: every existing row has '{}' for the new
-- column. Manually populate the fabric-core-api row once the team slug
-- is confirmed:
--
--   update public.projects
--   set github_team_slugs = array['<the-team-slug>']
--   where repo_slug = 'fabric-testbed/fabric-core-api';
