// teambrain-membership-sync/sync.ts — core sync pipeline for one project.
//
// Inputs:
//   * `project_id`, `repo_slug`, `github_team_slugs` — from public.projects.
//   * GitHub installation token — minted in github.ts.
//
// Output: a structured `SyncReport` plus the side-effects of upserting
// `public.project_members` rows via the service-role client. The report
// is also persisted to `public.sync_runs` by the calling handler.
//
// Membership policy ("C-plus" in Phase 3 § A1):
//
//   * If `github_team_slugs` is empty → desired set = `affiliation=all`
//     collaborators. Captures everyone with any kind of effective
//     repo access. Useful for projects without a curated team.
//
//   * If `github_team_slugs` is non-empty → desired set is gated by
//     ELIGIBILITY = (team members ∪ `affiliation=direct` collaborators).
//     The team is the primary policy lever; direct grants are an
//     escape hatch for one-off contributors. Default-org-permission
//     access alone does NOT confer TeamBrain membership.
//
//   * Role for an eligible user comes from the `affiliation=all`
//     collaborators response, which carries each user's *effective*
//     repo permission regardless of how access was granted. Mapping
//     is GitHub permission → TeamBrain `member_role` (§ A2):
//       admin                 → admin
//       maintain | push       → contributor
//       triage  | pull        → reader
//
//   * Users in the desired set with no `auth.users` row are SKIPPED
//     (counted in `skipped_no_auth_row`); their `project_members`
//     row materializes once they complete their first OAuth login.
//
//   * Removals set `removed_at = now()` (soft-delete per § A4 +
//     0008). A re-add clears `removed_at` and is reported as
//     `restored`.

import { SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';

import {
  GitHubPermission,
  getInstallationToken,
  listRepoCollaborators,
  listTeamMembers,
  getLastRateLimit,
} from './github.ts';

// ---------------------------------------------------------------------------
// Role mapping (Phase 3 § A2)
// ---------------------------------------------------------------------------

export type MemberRole = 'admin' | 'contributor' | 'reader';

// GitHub's permission ladder is one-way ordered. We collapse it to
// TeamBrain's three roles. Treat unknown strings as `reader` defensively
// (GitHub can add new permissions; we don't want a sync to crash on
// unknown values, and `reader` is the safe-fallback).
export function mapGithubPermission(p: GitHubPermission | string): MemberRole {
  switch (p) {
    case 'admin':                       return 'admin';
    case 'maintain':
    case 'push':                        return 'contributor';
    case 'triage':
    case 'pull':                        return 'reader';
    default:
      console.warn(`mapGithubPermission: unknown permission "${p}" — defaulting to reader`);
      return 'reader';
  }
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface SyncReport {
  project_slug:                string;
  github_collaborators_seen:   number;
  github_team_members_seen:    number;
  added:                       Array<{ login: string; role: MemberRole }>;
  updated:                     Array<{ login: string; old_role: MemberRole; new_role: MemberRole }>;
  removed:                     Array<{ login: string; previous_role: MemberRole }>;
  restored:                    Array<{ login: string; role: MemberRole }>;
  skipped_no_auth_row:         Array<{ login: string }>;
  duration_ms:                 number;
  rate_limit_remaining:        number | null;
}

// ---------------------------------------------------------------------------
// auth.users access (via GoTrue admin API)
// ---------------------------------------------------------------------------

interface AuthUser {
  id:             string;
  user_metadata?: Record<string, unknown> | null;
}

// Pulls every auth.users row visible to service-role. GoTrue caps
// perPage at 1000; we paginate defensively. The result is small for
// pilot scale (a few rows) but the loop is correct for growth.
async function listAllAuthUsers(service: SupabaseClient): Promise<AuthUser[]> {
  const all: AuthUser[] = [];
  let page = 1;
  // Hard cap on iterations as a safety net against a misbehaving API
  // returning a never-shrinking page.
  for (let i = 0; i < 100; i++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth.admin.listUsers page=${page} failed: ${error.message}`);
    const users = (data?.users ?? []) as AuthUser[];
    if (users.length === 0) break;
    all.push(...users);
    if (users.length < 1000) break;
    page += 1;
  }
  return all;
}

// ---------------------------------------------------------------------------
// One-project sync
// ---------------------------------------------------------------------------

export interface ProjectInput {
  project_id:        string;
  repo_slug:         string;             // 'owner/repo'
  github_team_slugs: string[];
}

export async function syncOneProject(
  service: SupabaseClient,
  project: ProjectInput,
): Promise<SyncReport> {
  const t0 = performance.now();

  const [owner, repo] = project.repo_slug.split('/');
  if (!owner || !repo) {
    throw new Error(`invalid repo_slug "${project.repo_slug}" — expected owner/repo`);
  }

  const token = await getInstallationToken();

  // 1. Pull `affiliation=all` collaborators — this is the source of
  //    TRUTH for each user's effective repo permission, regardless of
  //    how access was granted (team / direct / default-org-permission /
  //    owner). Build a login→role map we can index into later.
  const allCollaborators = await listRepoCollaborators(owner, repo, token, 'all');
  const roleByLogin = new Map<string, MemberRole>();
  for (const c of allCollaborators) {
    roleByLogin.set(c.login, mapGithubPermission(c.permission));
  }

  // 2. Determine the eligibility set per the C-plus policy.
  let eligibleLogins: Set<string>;
  let teamMembersSeen = 0;

  if (project.github_team_slugs.length === 0) {
    // No team configured → eligibility = anyone with effective access.
    eligibleLogins = new Set(roleByLogin.keys());
  } else {
    // Team configured → eligibility = team members ∪ explicit direct grants.
    // Note we do NOT first verify the team is listed in
    // `/repos/.../teams`. Many orgs grant repo access via default org
    // permission (no per-team grant), but still use a named team to
    // express *who should have TeamBrain access*. The team is the
    // policy artifact; whether it has a literal repo-level grant is
    // an implementation detail of how access is wired.
    eligibleLogins = new Set<string>();

    for (const slug of project.github_team_slugs) {
      const members = await listTeamMembers(owner, slug, token);
      teamMembersSeen += members.length;
      for (const login of members) eligibleLogins.add(login);
    }

    const directCollaborators = await listRepoCollaborators(owner, repo, token, 'direct');
    for (const c of directCollaborators) eligibleLogins.add(c.login);
  }

  // 3. Build the desired { login → role } map by intersecting
  //    eligibility with the role-of-truth map. A team member who has
  //    no effective access on the repo (degenerate case: on the team
  //    but the team grants no repo access AND the user has no other
  //    grant) is excluded — they have no role to assign and would
  //    fail any subsequent RLS evaluation anyway.
  const desired = new Map<string, MemberRole>();
  for (const login of eligibleLogins) {
    const role = roleByLogin.get(login);
    if (role) desired.set(login, role);
  }

  // 3. Resolve GitHub logins → auth.users.id via the GoTrue admin
  //    API. supabase-js's `.schema('auth').from('users')` requires
  //    `auth` to be in PGRST_DB_SCHEMAS, which the supabase docker
  //    default does NOT include (and exposing it broadly is not
  //    desirable). The admin API is the supported path: service-role
  //    only, paginated, returns the `user_metadata.user_name` we need.
  //
  //    perPage 1000 is the GoTrue ceiling. For pilot-scale auth.users
  //    (single-digit users) one page is plenty; we still paginate for
  //    correctness so the function scales without revisit.
  const allAuthUsers = await listAllAuthUsers(service);
  const handleToUserId  = new Map<string, string>();
  const userIdToHandle  = new Map<string, string>();
  for (const u of allAuthUsers) {
    const handle = (u.user_metadata as { user_name?: string } | null)?.user_name;
    if (!handle) continue;
    handleToUserId.set(handle, u.id);
    userIdToHandle.set(u.id, handle);
  }

  const desiredLogins = Array.from(desired.keys());
  const skippedNoAuthRow: Array<{ login: string }> = [];
  const loginToUserId = new Map<string, string>();
  for (const login of desiredLogins) {
    const userId = handleToUserId.get(login);
    if (userId) loginToUserId.set(login, userId);
    else        skippedNoAuthRow.push({ login });
  }

  // 5. Pull current project_members (including tombstones — we may need
  //    to restore one).
  const { data: currentRows, error: currentErr } = await service
    .from('project_members')
    .select('user_id, role, removed_at')
    .eq('project_id', project.project_id);
  if (currentErr) throw new Error(`project_members fetch failed: ${currentErr.message}`);

  // user_id → row
  type CurrentRow = { user_id: string; role: MemberRole; removed_at: string | null };
  const currentByUserId = new Map<string, CurrentRow>(
    (currentRows ?? []).map((r) => [r.user_id, r as CurrentRow]),
  );

  // user_id → desired role (only for logins that resolved).
  const desiredByUserId = new Map<string, { login: string; role: MemberRole }>();
  for (const [login, role] of desired) {
    const userId = loginToUserId.get(login);
    if (userId) desiredByUserId.set(userId, { login, role });
  }

  // 6. Compute diff.
  const added:    SyncReport['added']    = [];
  const updated:  SyncReport['updated']  = [];
  const removed:  SyncReport['removed']  = [];
  const restored: SyncReport['restored'] = [];

  // Adds + role changes + restores (re-add of tombstoned).
  const upserts: Array<{ project_id: string; user_id: string; role: MemberRole; removed_at: null }> = [];
  for (const [userId, want] of desiredByUserId) {
    const current = currentByUserId.get(userId);
    if (!current) {
      added.push({ login: want.login, role: want.role });
      upserts.push({ project_id: project.project_id, user_id: userId, role: want.role, removed_at: null });
    } else if (current.removed_at !== null) {
      restored.push({ login: want.login, role: want.role });
      upserts.push({ project_id: project.project_id, user_id: userId, role: want.role, removed_at: null });
    } else if (current.role !== want.role) {
      updated.push({ login: want.login, old_role: current.role, new_role: want.role });
      upserts.push({ project_id: project.project_id, user_id: userId, role: want.role, removed_at: null });
    }
  }

  // Removals: anyone in current (not tombstoned) but not in desired.
  const removeUserIds: string[] = [];
  for (const [userId, current] of currentByUserId) {
    if (current.removed_at !== null) continue;          // already tombstoned
    if (desiredByUserId.has(userId))   continue;        // still wanted
    removed.push({ login: '<auth-only>', previous_role: current.role });
    removeUserIds.push(userId);
  }

  // Pretty-fill the `removed[].login` field from the userIdToHandle
  // map we built above. Best-effort: if a user_id has no GitHub handle
  // in user_metadata (e.g. legacy seeded row), the placeholder
  // '<auth-only>' stays.
  for (let i = 0; i < removed.length; i++) {
    const handle = userIdToHandle.get(removeUserIds[i]);
    if (handle) removed[i].login = handle;
  }

  // 7. Apply diff via service_role.
  if (upserts.length > 0) {
    const { error } = await service
      .from('project_members')
      .upsert(upserts, { onConflict: 'project_id,user_id' });
    if (error) throw new Error(`project_members upsert failed: ${error.message}`);
  }
  if (removeUserIds.length > 0) {
    const nowIso = new Date().toISOString();
    const { error } = await service
      .from('project_members')
      .update({ removed_at: nowIso })
      .eq('project_id', project.project_id)
      .in('user_id', removeUserIds);
    if (error) throw new Error(`project_members tombstone failed: ${error.message}`);
  }

  const rate = getLastRateLimit();
  return {
    project_slug:              project.repo_slug,
    github_collaborators_seen: allCollaborators.length,
    github_team_members_seen:  teamMembersSeen,
    added,
    updated,
    removed,
    restored,
    skipped_no_auth_row:       skippedNoAuthRow,
    duration_ms:               Math.round(performance.now() - t0),
    rate_limit_remaining:      rate ? rate.remaining : null,
  };
}
