// teambrain-console/index.ts — GitHub-touching reads + actions backing the
// /repos management dashboard. The DB-derived per-repo status comes from the
// public.repo_status_overview() / repo_status_detail() RPCs (migration 0024)
// called by the page directly via PostgREST; this function does only the parts
// that need GitHub or the service client:
//
//   GET  /discover        — fabric-testbed org repos the caller ADMINS on GitHub
//                           but hasn't registered yet (one-click "add" candidates)
//   GET  /repo?slug=      — per-repo GitHub detail (default branch, whether the
//                           capture-on-merge workflow / AGENTS.md already exist)
//   POST /agents-md       — deterministic per-slug AGENTS.md (no LLM)
//   POST /setup-pr        — open ONE PR adding the workflow + AGENTS.md (admin)
//   POST /sync-now        — trigger a membership re-sync for the project (admin)
//   GET  /health          — liveness
//
// Auth model mirrors teambrain-register-project: a GitHub-OAuth USER JWT
// (role=authenticated), signature pre-verified by the dispatcher; we read
// claims without re-verifying. Project member/admin gating is checked against
// public.project_members via the service client (the same explicit check
// promote.ts uses, since the side effects are on GitHub, not the DB, so RLS
// can't gate them implicitly). This function reuses the GitHub App token mint,
// repo helpers, and per-project sync from sibling functions rather than
// duplicating them — all co-deploy under one Edge Runtime root, so the relative
// imports resolve at runtime.

import { Hono } from 'npm:hono@^4.6.0';
import type { ContentfulStatusCode } from 'npm:hono@^4.6.0/utils/http-status';
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';

import {
  getInstallationToken,
  listInstallationRepos,
  getUserRepoPermission,
  repoFileExists,
} from '../teambrain-membership-sync/github.ts';
import { syncOneProject, SyncReport } from '../teambrain-membership-sync/sync.ts';
import { commitFilesAndOpenPR, GitHubPrError } from '../teambrain-mcp/github-pr.ts';
import { renderAgentsMd, captureOnMergeYml } from './agents-md.ts';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const GITHUB_ORG                = Deno.env.get('TEAMBRAIN_GITHUB_ORG');
// {TEAMBRAIN_URL} for generated AGENTS.md. Prefer an explicit override, else
// reuse the stack's public URL (already passed to the functions container).
const PUBLIC_URL                = Deno.env.get('TEAMBRAIN_PUBLIC_URL')
  ?? Deno.env.get('SUPABASE_PUBLIC_URL')
  ?? 'https://pr.fabric-testbed.net';

// Bound discovery so a large installation can't fan out into hundreds of
// per-repo permission checks on one request.
const DISCOVER_REPO_CAP      = 200;   // installation repos considered
const DISCOVER_PERM_CAP      = 80;    // unregistered repos we permission-check
const DISCOVER_CONCURRENCY   = 6;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('teambrain-console: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY at boot');
}
if (!GITHUB_ORG) {
  console.error('teambrain-console: missing TEAMBRAIN_GITHUB_ORG — discovery will return nothing until it is set');
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

// Console actions are user actions: require the `authenticated` role (a GitHub
// OAuth user token), reject service_role / anon, return the caller's auth.uid().
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
// Project / membership helpers (service client)
// ---------------------------------------------------------------------------

interface ProjectRow {
  id:                string;
  repo_slug:         string;
  name:              string;
  github_team_slugs: string[] | null;
  created_by:        string | null;
}

async function resolveProject(service: SupabaseClient, slug: string): Promise<ProjectRow | null> {
  const { data, error } = await service
    .from('projects')
    .select('id, repo_slug, name, github_team_slugs, created_by')
    .eq('repo_slug', slug)
    .maybeSingle();
  if (error) throw new HttpError(502, `project lookup failed: ${error.message}`);
  return (data as ProjectRow | null) ?? null;
}

// The caller's active role on a project, or null if they are not a member.
async function callerRole(service: SupabaseClient, projectId: string, userId: string): Promise<string | null> {
  const { data, error } = await service
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .is('removed_at', null)
    .maybeSingle();
  if (error) throw new HttpError(502, `membership lookup failed: ${error.message}`);
  return (data as { role?: string } | null)?.role ?? null;
}

// Resolve auth.uid() → GitHub login (user_metadata.user_name). Returns null on
// any failure (best-effort: discovery / AGENTS.md degrade gracefully).
async function githubLoginSafe(service: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data, error } = await service.auth.admin.getUserById(userId);
    if (error) return null;
    const handle = (data?.user?.user_metadata as { user_name?: string } | null | undefined)?.user_name;
    return handle ?? null;
  } catch {
    return null;
  }
}

// Validate "owner/repo"; throw 400 otherwise.
function parseSlug(slug: unknown): { slug: string; owner: string; repo: string } {
  const s = typeof slug === 'string' ? slug.trim() : '';
  if (!s || !/^[^/\s]+\/[^/\s]+$/.test(s)) throw new HttpError(400, 'slug required, format "owner/repo"');
  const [owner, repo] = s.split('/');
  return { slug: s, owner, repo };
}

// Resolve project + require the caller be a member; returns {project, role}.
async function requireMember(
  service: SupabaseClient, slug: string, userId: string,
): Promise<{ project: ProjectRow; role: string }> {
  const project = await resolveProject(service, slug);
  if (!project) throw new HttpError(404, `project "${slug}" is not registered`);
  const role = await callerRole(service, project.id, userId);
  if (!role) throw new HttpError(403, `you are not a member of ${slug}`);
  return { project, role };
}

function requireAdminRole(role: string, slug: string): void {
  if (role !== 'admin') throw new HttpError(403, `this action requires admin on ${slug} (your role: ${role})`);
}

// Small concurrency limiter for the per-repo discovery checks.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

// GET /repos/{owner}/{repo} → default branch (installation-token auth).
async function getDefaultBranch(owner: string, repo: string, token: string): Promise<string> {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) throw new HttpError(502, `repo lookup for ${owner}/${repo} failed: ${resp.status}`);
  const json = await resp.json() as { default_branch?: string };
  return json.default_branch ?? 'main';
}

const WORKFLOW_PATH = '.github/workflows/capture-on-merge.yml';
const AGENTS_MD_PATH = 'AGENTS.md';

// AGENTS.md lead/reviewers from the project's admins (best-effort).
async function leadAndReviewers(
  service: SupabaseClient, project: ProjectRow,
): Promise<{ lead: string; reviewers: string }> {
  const { data } = await service
    .from('project_members')
    .select('user_id')
    .eq('project_id', project.id)
    .eq('role', 'admin')
    .is('removed_at', null)
    .eq('is_service_account', false);
  const adminIds = (data as { user_id: string }[] | null ?? []).map((r) => r.user_id);

  const logins: string[] = [];
  for (const id of adminIds) {
    const login = await githubLoginSafe(service, id);
    if (login) logins.push(login);
  }
  let lead = project.created_by ? await githubLoginSafe(service, project.created_by) : null;
  if (!lead && logins.length) lead = logins[0];
  const reviewers = logins.filter((l) => l !== lead);
  return {
    lead:      lead ?? '{PROJECT_LEAD}',
    reviewers: reviewers.length ? reviewers.join(', ') : '{PILOT_REVIEWERS}',
  };
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono().basePath('/teambrain-console');

const auth = (c: { req: { header: (k: string) => string | undefined } }): string =>
  requireUser(c.req.header('authorization') ?? c.req.header('Authorization') ?? null);

app.get('/health', (c) => c.json({ service: 'teambrain-console', version: 1, checked_at: new Date().toISOString() }));

// --- discover: org repos the caller admins but hasn't registered -------------
app.get('/discover', async (c) => {
  let userId: string;
  try { userId = auth(c); } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  if (!GITHUB_ORG) return c.json({ org: null, candidates: [], scanned: 0, capped: false });

  const service = serviceClient();
  const login = await githubLoginSafe(service, userId);
  if (!login) return c.json({ error: 'no GitHub identity on this account (user_metadata.user_name absent)' }, 403);

  let token: string;
  try { token = await getInstallationToken(); } catch (err) {
    return c.json({ error: `GitHub App token mint failed: ${(err as Error).message}` }, 502);
  }

  // Registered slugs (so we surface only NOT-yet-registered repos).
  const { data: projRows } = await service.from('projects').select('repo_slug');
  const registered = new Set((projRows as { repo_slug: string }[] | null ?? []).map((r) => r.repo_slug.toLowerCase()));

  let repos;
  try { repos = await listInstallationRepos(token); } catch (err) {
    return c.json({ error: `listing installation repos failed: ${(err as Error).message}` }, 502);
  }

  const inOrg = repos
    .filter((r) => r.owner_login.toLowerCase() === GITHUB_ORG.toLowerCase() && !r.archived)
    .slice(0, DISCOVER_REPO_CAP);
  const unregistered = inOrg.filter((r) => !registered.has(r.full_name.toLowerCase()));
  const capped = unregistered.length > DISCOVER_PERM_CAP;
  const toCheck = unregistered.slice(0, DISCOVER_PERM_CAP);

  const checked = await mapLimit(toCheck, DISCOVER_CONCURRENCY, async (r) => {
    try {
      const perm = await getUserRepoPermission(r.owner_login, r.name, login, token);
      return perm === 'admin' ? r : null;
    } catch {
      return null;   // a single repo's permission hiccup must not fail discovery
    }
  });

  const candidates = checked
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => ({ slug: r.full_name, default_branch: r.default_branch, private: r.private }));

  return c.json({ org: GITHUB_ORG, candidates, scanned: toCheck.length, capped });
});

// --- repo: GitHub-derived detail for the drill-down -------------------------
app.get('/repo', async (c) => {
  let userId: string;
  try { userId = auth(c); } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const service = serviceClient();
  let project: ProjectRow, role: string, owner: string, repo: string, slug: string;
  try {
    ({ slug, owner, repo } = parseSlug(c.req.query('slug')));
    ({ project, role } = await requireMember(service, slug, userId));
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  try {
    const token = await getInstallationToken();
    const defaultBranch = await getDefaultBranch(owner, repo, token);
    const [hasWorkflow, hasAgents] = await Promise.all([
      repoFileExists(owner, repo, WORKFLOW_PATH, token, defaultBranch),
      repoFileExists(owner, repo, AGENTS_MD_PATH, token, defaultBranch),
    ]);
    return c.json({
      slug, project_name: project.name, role, is_admin: role === 'admin',
      default_branch: defaultBranch,
      has_capture_workflow: hasWorkflow,
      has_agents_md: hasAgents,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    return c.json({ error: `GitHub check failed: ${(err as Error).message}` }, 502);
  }
});

// --- agents-md: deterministic per-slug AGENTS.md ----------------------------
app.post('/agents-md', async (c) => {
  let userId: string;
  try { userId = auth(c); } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const service = serviceClient();
  let body: { slug?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'request body must be JSON' }, 400); }

  let project: ProjectRow, slug: string;
  try {
    ({ slug } = parseSlug(body.slug));
    ({ project } = await requireMember(service, slug, userId));
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const { lead, reviewers } = await leadAndReviewers(service, project);
  const content = renderAgentsMd({
    slug,
    projectName:    project.name,
    teambrainUrl:   PUBLIC_URL,
    projectLead:    lead,
    pilotReviewers: reviewers,
  });
  return c.json({ filename: AGENTS_MD_PATH, content });
});

// --- setup-pr: open one PR adding the workflow + AGENTS.md (admin) -----------
app.post('/setup-pr', async (c) => {
  let userId: string;
  try { userId = auth(c); } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const service = serviceClient();
  let body: { slug?: unknown; include?: unknown; target_branch?: unknown; overwrite?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'request body must be JSON' }, 400); }

  let project: ProjectRow, role: string, owner: string, repo: string, slug: string;
  try {
    ({ slug, owner, repo } = parseSlug(body.slug));
    ({ project, role } = await requireMember(service, slug, userId));
    requireAdminRole(role, slug);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const include = Array.isArray(body.include)
    ? body.include.filter((s): s is string => typeof s === 'string')
    : ['workflow', 'agents_md'];
  const wantWorkflow = include.includes('workflow');
  const wantAgents   = include.includes('agents_md');
  if (!wantWorkflow && !wantAgents) return c.json({ error: 'include must contain "workflow" and/or "agents_md"' }, 400);
  // Default is NON-destructive: a file that already exists on the base branch is
  // SKIPPED, not overwritten — so this never silently clobbers a human-owned
  // AGENTS.md or a workflow that's ahead of our embedded template. Pass
  // overwrite:true (the AGENTS.md "update" action) to replace in place.
  const overwrite = body.overwrite === true;

  try {
    const token = await getInstallationToken();
    const base = typeof body.target_branch === 'string' && body.target_branch.trim()
      ? body.target_branch.trim()
      : await getDefaultBranch(owner, repo, token);

    const requested: { kind: 'workflow' | 'agents_md'; path: string }[] = [];
    if (wantWorkflow) requested.push({ kind: 'workflow', path: WORKFLOW_PATH });
    if (wantAgents)   requested.push({ kind: 'agents_md', path: AGENTS_MD_PATH });

    const files: { path: string; content: string }[] = [];
    const skipped: string[] = [];
    for (const r of requested) {
      if (!overwrite && await repoFileExists(owner, repo, r.path, token, base)) {
        skipped.push(r.path);
        continue;
      }
      if (r.kind === 'workflow') {
        files.push({ path: r.path, content: captureOnMergeYml() });
      } else {
        const { lead, reviewers } = await leadAndReviewers(service, project);
        files.push({ path: r.path, content: renderAgentsMd({
          slug, projectName: project.name, teambrainUrl: PUBLIC_URL,
          projectLead: lead, pilotReviewers: reviewers,
        }) });
      }
    }

    if (files.length === 0) {
      return c.json({
        opened: false,
        skipped,
        message: `Nothing to do — ${skipped.join(', ')} already exist on ${base}. ` +
          `Use the AGENTS.md "update" action (overwrite) to replace one.`,
      }, 200);
    }

    const writingWorkflow = files.some((f) => f.path === WORKFLOW_PATH);
    const writingAgents   = files.some((f) => f.path === AGENTS_MD_PATH);
    const what = [writingWorkflow ? 'capture-on-merge' : null, writingAgents ? 'AGENTS.md' : null]
      .filter(Boolean).join(' + ');
    const prBody = [
      `This PR wires **${slug}** into TeamBrain (opened from the /repos dashboard).`,
      '',
      'Files added/updated:',
      writingWorkflow ? '- `.github/workflows/capture-on-merge.yml` — proposes TeamBrain captures on PR merge (human-approved).' : null,
      writingAgents   ? '- `AGENTS.md` — agent orientation for this repo.' : null,
      skipped.length  ? `\n_Skipped (already present, not overwritten): ${skipped.join(', ')}._` : null,
      '',
      ...(writingWorkflow ? [
        '**Remaining manual steps for capture-on-merge** (the GitHub App cannot set repo secrets):',
        '1. Issue an API token from the dashboard (or `POST /functions/v1/teambrain-token/token`).',
        '2. `gh secret set TEAMBRAIN_TOKEN` — the `tbk_…` value (a repo **secret**).',
        '3. `gh variable set TEAMBRAIN_ANON_KEY` — the public anon key from the landing page (a repo **variable**).',
        '4. (optional) `gh variable set TEAMBRAIN_APPROVERS` — comma/newline-separated approver logins.',
        '5. Merge this PR.',
        '',
      ] : []),
      'Review the contents, then merge.',
    ].filter((x) => x !== null).join('\n');

    const result = await commitFilesAndOpenPR(token, owner, repo, {
      branch: 'teambrain/setup',
      base,
      files,
      title: `ci: TeamBrain setup (${what})`,
      body: prBody,
    });
    return c.json({ opened: true, ...result, skipped }, 201);
  } catch (err) {
    if (err instanceof GitHubPrError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    return c.json({ error: `setup PR failed: ${(err as Error).message}` }, 502);
  }
});

// --- sync-now: trigger a membership re-sync (admin) -------------------------
app.post('/sync-now', async (c) => {
  let userId: string;
  try { userId = auth(c); } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const service = serviceClient();
  let body: { slug?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'request body must be JSON' }, 400); }

  let project: ProjectRow, role: string, slug: string;
  try {
    ({ slug } = parseSlug(body.slug));
    ({ project, role } = await requireMember(service, slug, userId));
    requireAdminRole(role, slug);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const startedAt = new Date().toISOString();
  let report: SyncReport | null = null;
  let syncError: string | null = null;
  try {
    report = await syncOneProject(service, {
      project_id:        project.id,
      repo_slug:         project.repo_slug,
      github_team_slugs: project.github_team_slugs ?? [],
    });
  } catch (err) {
    syncError = (err as Error).message;
  }
  // Record the run exactly as register-project does (sync_runs is the source of
  // truth the overview RPC's last_sync_* reads).
  const { error: runErr } = await service.from('sync_runs').insert({
    project_id:  project.id,
    started_at:  startedAt,
    finished_at: new Date().toISOString(),
    ok:          syncError === null,
    report,
    error:       syncError,
  });
  if (runErr) console.error(`sync_runs insert failed: ${runErr.message}`);

  if (syncError) return c.json({ ok: false, error: syncError }, 502);
  return c.json({ ok: true, report });
});

// --- capture-toggle: enable/disable capture-on-merge (admin) ----------------
// Central, slug-keyed kill switch for the capture-on-merge GitHub Action
// (migration 0026). projects has NO update grant to `authenticated` (0002), so
// the service client is the only write path — admin gating is enforced here in
// app code, exactly like sync-now. The committed workflow reads the flag via
// GET /teambrain-rest/project and clean-skips when it is false, so an admin can
// silence a minute-hungry repo without touching its workflow file.
app.post('/capture-toggle', async (c) => {
  let userId: string;
  try { userId = auth(c); } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }
  const service = serviceClient();
  let body: { slug?: unknown; enabled?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'request body must be JSON' }, 400); }
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400);

  let project: ProjectRow, role: string, slug: string;
  try {
    ({ slug } = parseSlug(body.slug));
    ({ project, role } = await requireMember(service, slug, userId));
    requireAdminRole(role, slug);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const { error } = await service
    .from('projects')
    .update({ capture_on_merge_enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq('id', project.id);
  if (error) return c.json({ error: `capture-toggle failed: ${error.message}` }, 502);

  return c.json({ ok: true, slug, capture_on_merge_enabled: body.enabled });
});

app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
