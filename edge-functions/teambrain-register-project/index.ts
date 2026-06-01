// teambrain-register-project/index.ts — Phase 4 self-service project
// registration, gated on GitHub repo-admin permission.
//
// One HTTP endpoint:
//
//   POST /register
//     body: { repo_slug: "owner/repo", name?: string,
//             github_team_slugs?: string[] }
//
// Authorization model (the reason this function exists):
//   * Caller presents a GitHub-OAuth *user* JWT (role = `authenticated`).
//     The dispatcher (functions/main) has already validated the signature
//     against GoTrue's JWKS; we read claims without re-verifying, same as
//     the MCP and membership-sync functions.
//   * Two gates, both must pass:
//       1. ORG gate     — repo owner must equal TEAMBRAIN_GITHUB_ORG. The
//                          GitHub App installation is org-scoped, so a repo
//                          outside the org also fails the collaborator call
//                          (404) — belt and suspenders.
//       2. REPO-ADMIN   — the caller's effective permission on the repo,
//          gate            as reported by GitHub, must be `admin`. This is
//                          what makes registration self-service-but-not-a-
//                          free-for-all: anyone in the org who administers a
//                          repo can register it; nobody else can.
//
// On success the function (as service_role):
//   1. inserts the `projects` row (created_by = caller),
//   2. seeds the caller as `admin` in `project_members` (the only way a
//      project becomes visible to its creator — RLS denies `authenticated`
//      any write on project_members), then
//   3. runs the membership sync to pull in the rest of the team, recording
//      the run to `public.sync_runs`.
//
// This function deliberately reuses the GitHub App token mint, the
// collaborator listing, and the per-project sync from the sibling
// `teambrain-membership-sync` function rather than duplicating them. Both
// functions are mounted under the same Edge Runtime functions root, so the
// relative imports resolve at runtime; the shared modules depend only on
// fully-qualified `npm:` specifiers, not on either function's import map.

import { Hono } from 'npm:hono@^4.6.0';
import type { ContentfulStatusCode } from 'npm:hono@^4.6.0/utils/http-status';
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';

import { CollaboratorRow, getInstallationToken, listRepoCollaborators } from '../teambrain-membership-sync/github.ts';
import { syncOneProject, SyncReport } from '../teambrain-membership-sync/sync.ts';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GITHUB_ORG                = Deno.env.get('TEAMBRAIN_GITHUB_ORG');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'teambrain-register-project: missing SUPABASE_URL or ' +
    'SUPABASE_SERVICE_ROLE_KEY at boot',
  );
}
if (!GITHUB_ORG) {
  console.error(
    'teambrain-register-project: missing TEAMBRAIN_GITHUB_ORG — every ' +
    'registration will be rejected by the org gate until it is set',
  );
}

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });
}

// ---------------------------------------------------------------------------
// JWT claims (signature already validated by the dispatcher)
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) { super(message); }
}

interface Claims { sub: string; role: string; }

function jwtClaims(authHeader: string): Claims {
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT not in three-segment form');
  const padded  = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  if (typeof payload.sub !== 'string')  throw new Error('JWT missing `sub` claim');
  if (typeof payload.role !== 'string') throw new Error('JWT missing `role` claim');
  return { sub: payload.sub, role: payload.role };
}

// Registration is a user action. We require the `authenticated` role and
// return the caller's auth.uid() (`sub`). `service_role` and `anon` are
// rejected: a service-role caller wanting to create a project for someone
// else bypasses the repo-admin gate entirely and should do so via direct
// SQL, not this endpoint.
function requireUser(authHeader: string | null): string {
  if (!authHeader) throw new HttpError(401, 'Authorization header required');
  let claims: Claims;
  try {
    claims = jwtClaims(authHeader);
  } catch (err) {
    throw new HttpError(401, `JWT decode failed: ${(err as Error).message}`);
  }
  if (claims.role !== 'authenticated') {
    throw new HttpError(403, `role=${claims.role} not permitted; a GitHub-OAuth user token is required`);
  }
  return claims.sub;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolve auth.uid() → GitHub login via the GoTrue admin API. GitHub OAuth
// stores the handle in user_metadata.user_name (same field the membership
// sync keys off of).
async function githubLoginForUser(service: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await service.auth.admin.getUserById(userId);
  if (error) throw new HttpError(500, `auth lookup failed: ${error.message}`);
  const handle = (data?.user?.user_metadata as { user_name?: string } | null | undefined)?.user_name;
  if (!handle) {
    throw new HttpError(403, 'no GitHub identity on this account (user_metadata.user_name absent)');
  }
  return handle;
}

interface SyncRunRow {
  project_id:  string | null;
  started_at:  string;
  finished_at: string;
  ok:          boolean;
  report:      unknown;
  error:       string | null;
}

async function recordRun(service: SupabaseClient, row: SyncRunRow): Promise<void> {
  const { error } = await service.from('sync_runs').insert(row);
  if (error) console.error(`sync_runs insert failed: ${error.message}`);
}

interface RegisterBody {
  repo_slug?:         unknown;
  name?:              unknown;
  github_team_slugs?: unknown;
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono().basePath('/teambrain-register-project');

app.post('/register', async (c) => {
  let callerUserId: string;
  try {
    callerUserId = requireUser(c.req.header('authorization') ?? c.req.header('Authorization') ?? null);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  // --- Parse + validate body ------------------------------------------------
  let body: RegisterBody;
  try {
    body = await c.req.json() as RegisterBody;
  } catch {
    return c.json({ error: 'request body must be JSON' }, 400);
  }

  const repoSlug = typeof body.repo_slug === 'string' ? body.repo_slug.trim() : '';
  if (!repoSlug || !/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) {
    return c.json({ error: 'repo_slug required, format "owner/repo"' }, 400);
  }
  const [owner, repo] = repoSlug.split('/');

  if (!GITHUB_ORG) {
    return c.json({ error: 'server misconfigured: TEAMBRAIN_GITHUB_ORG not set' }, 500);
  }
  if (owner.toLowerCase() !== GITHUB_ORG.toLowerCase()) {
    return c.json({ error: `repo owner must be the "${GITHUB_ORG}" GitHub org` }, 403);
  }

  const teamSlugs: string[] = Array.isArray(body.github_team_slugs)
    ? body.github_team_slugs.filter((s): s is string => typeof s === 'string')
    : [];
  const displayName = typeof body.name === 'string' && body.name.trim() !== ''
    ? body.name.trim()
    : repoSlug;

  const service = serviceClient();

  // --- Repo-admin gate ------------------------------------------------------
  let callerLogin: string;
  try {
    callerLogin = await githubLoginForUser(service, callerUserId);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  let collaborators: CollaboratorRow[];
  try {
    const token = await getInstallationToken();
    collaborators = await listRepoCollaborators(owner, repo, token, 'all');
  } catch (err) {
    // A 404 from the collaborator listing means the installation cannot see
    // the repo — either it does not exist or the App is not installed on it.
    const message = (err as Error).message;
    if (/\b404\b/.test(message)) {
      return c.json({ error: `repo "${repoSlug}" not found or not accessible to the TeamBrain GitHub App` }, 404);
    }
    return c.json({ error: `GitHub permission check failed: ${message}` }, 502);
  }

  const callerRow = collaborators.find((cr) => cr.login.toLowerCase() === callerLogin.toLowerCase());
  if (!callerRow) {
    return c.json({ error: `${callerLogin} is not a collaborator on ${repoSlug}` }, 403);
  }
  if (callerRow.permission !== 'admin') {
    return c.json(
      { error: `registering ${repoSlug} requires admin permission on the repo; ${callerLogin} has "${callerRow.permission}"` },
      403,
    );
  }

  // --- Insert project -------------------------------------------------------
  const { data: projectRow, error: insertErr } = await service
    .from('projects')
    .insert({ repo_slug: repoSlug, name: displayName, created_by: callerUserId, github_team_slugs: teamSlugs })
    .select('id, repo_slug, name, github_team_slugs, created_by, created_at')
    .single();

  if (insertErr) {
    // unique_violation on repo_slug — already registered.
    if ((insertErr as { code?: string }).code === '23505') {
      return c.json({ error: `project "${repoSlug}" is already registered` }, 409);
    }
    return c.json({ error: `project insert failed: ${insertErr.message}` }, 500);
  }

  // --- Seed creator as admin ------------------------------------------------
  const { error: seedErr } = await service
    .from('project_members')
    .upsert(
      { project_id: projectRow.id, user_id: callerUserId, role: 'admin', removed_at: null },
      { onConflict: 'project_id,user_id' },
    );
  if (seedErr) {
    return c.json({ error: `project created (${projectRow.id}) but seeding creator as admin failed: ${seedErr.message}` }, 500);
  }

  // --- Sync the rest of the team --------------------------------------------
  const startedAt = new Date().toISOString();
  let report: SyncReport | null = null;
  let syncError: string | null = null;
  try {
    report = await syncOneProject(service, {
      project_id:        projectRow.id,
      repo_slug:         projectRow.repo_slug,
      github_team_slugs: projectRow.github_team_slugs ?? [],
    });
  } catch (err) {
    syncError = (err as Error).message;
  }
  await recordRun(service, {
    project_id:  projectRow.id,
    started_at:  startedAt,
    finished_at: new Date().toISOString(),
    ok:          syncError === null,
    report,
    error:       syncError,
  });

  // The project exists and the creator is an admin regardless of whether the
  // follow-up team sync succeeded — report partial success rather than
  // failing the whole registration on a transient GitHub hiccup. The next
  // scheduled /sync-all will reconcile the rest of the team.
  return c.json({
    project: projectRow,
    sync:    syncError === null ? report : { error: syncError, note: 'project registered; team sync will retry on next scheduled run' },
  }, 201);
});

app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
