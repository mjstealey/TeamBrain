// teambrain-staleness/index.ts — Phase 6 § C commit-triggered staleness poller.
//
// Two HTTP endpoints:
//
//   POST /scan            — service-role. For each registered project (or one
//                           via {project_slug}), diff the default branch's new
//                           commits since the stored cursor and flag thoughts
//                           whose pinned paths were touched, via the
//                           public.flag_thoughts_for_paths(...) RPC. The FIRST
//                           scan of a repo seeds the cursor and flags nothing
//                           (no historical backfill). Driven by pg_cron (0019)
//                           every 15 min; operator-callable on demand.
//   GET  /health          — anon-pingable. Per-project poll freshness.
//
// This is NOT an MCP server and exposes no per-user surface — like
// teambrain-membership-sync it works entirely through the service-role client,
// and asserts the JWT `role` claim is service_role on /scan. It reuses that
// function's getInstallationToken() (cross-import; both deploy under the same
// volumes/functions/ root). The matching + flagging logic lives in the DB
// (flag_thoughts_for_paths) so every signal producer shares one implementation.

import { Hono } from 'npm:hono@^4.6.0';
import type { ContentfulStatusCode } from 'npm:hono@^4.6.0/utils/http-status';
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';

import { getInstallationToken } from '../teambrain-membership-sync/github.ts';
import { getRepoHead, compareChangedPaths } from './commits.ts';

// ---------------------------------------------------------------------------
// Env + service client
// ---------------------------------------------------------------------------

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('teambrain-staleness: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY at boot');
}

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });
}

// ---------------------------------------------------------------------------
// JWT role assertion (same pattern as teambrain-membership-sync)
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) { super(message); }
}

function jwtRole(authHeader: string): string {
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT not in three-segment form');
  const padded  = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  if (typeof payload.role !== 'string') throw new Error('JWT missing `role` claim');
  return payload.role;
}

function requireServiceRole(authHeader: string | null): void {
  if (!authHeader) throw new HttpError(401, 'Authorization header required');
  let role: string;
  try {
    role = jwtRole(authHeader);
  } catch (err) {
    throw new HttpError(401, `JWT decode failed: ${(err as Error).message}`);
  }
  if (role !== 'service_role') {
    throw new HttpError(403, `role=${role} not permitted; service_role required`);
  }
}

// ---------------------------------------------------------------------------
// Per-project scan
// ---------------------------------------------------------------------------

interface ProjectRow { id: string; repo_slug: string | null; }

interface ProjectScanReport {
  project_slug:   string;
  head?:          string;
  base?:          string;
  seeded?:        boolean;
  unchanged?:     boolean;
  changed_paths?: number;
  flagged?:       number;
  flagged_ids?:   string[];
  truncated?:     boolean;
  error?:         string;
}

async function upsertCursor(
  service: SupabaseClient,
  projectId: string,
  defaultBranch: string,
  headSha: string,
): Promise<void> {
  const { error } = await service.from('staleness_poll_state').upsert({
    project_id:     projectId,
    default_branch: defaultBranch,
    last_sha:       headSha,
    last_polled_at: new Date().toISOString(),
    updated_at:     new Date().toISOString(),
  });
  if (error) throw new Error(`cursor upsert failed: ${error.message}`);
}

async function scanProject(
  service: SupabaseClient,
  token:   string,
  project: ProjectRow,
): Promise<ProjectScanReport> {
  const slug = project.repo_slug ?? '';
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) return { project_slug: slug, error: 'repo_slug is not owner/repo' };

  const head = await getRepoHead(owner, repo, token);

  const { data: stateRow, error: stateErr } = await service
    .from('staleness_poll_state')
    .select('last_sha')
    .eq('project_id', project.id)
    .maybeSingle();
  if (stateErr) throw new Error(`poll-state read failed: ${stateErr.message}`);
  const lastSha = (stateRow as { last_sha: string | null } | null)?.last_sha ?? null;

  // First scan: seed the cursor, flag nothing (no historical backfill).
  if (!lastSha) {
    await upsertCursor(service, project.id, head.defaultBranch, head.headSha);
    return { project_slug: slug, head: head.headSha, seeded: true, flagged: 0 };
  }

  // No new commits since last scan.
  if (lastSha === head.headSha) {
    await upsertCursor(service, project.id, head.defaultBranch, head.headSha);
    return { project_slug: slug, head: head.headSha, unchanged: true, flagged: 0 };
  }

  const changed = await compareChangedPaths(owner, repo, lastSha, head.headSha, token);

  let flaggedIds: string[] = [];
  if (changed.paths.length > 0) {
    const { data, error } = await service.rpc('flag_thoughts_for_paths', {
      p_project_id:    project.id,
      p_changed_paths: changed.paths,
      p_signal_kind:   'commit_touched_path',
      p_detail: {
        repo:          slug,
        base:          lastSha,
        head:          head.headSha,
        commits:       changed.commitCount,
        changed_paths: changed.paths.slice(0, 50),
        truncated:     changed.truncated,
      },
    });
    if (error) throw new Error(`flag_thoughts_for_paths failed: ${error.message} (code=${error.code ?? 'n/a'})`);
    flaggedIds = ((data ?? []) as { thought_id: string }[]).map((r) => r.thought_id);
  }

  await upsertCursor(service, project.id, head.defaultBranch, head.headSha);

  return {
    project_slug:  slug,
    head:          head.headSha,
    base:          lastSha,
    changed_paths: changed.paths.length,
    flagged:       flaggedIds.length,
    flagged_ids:   flaggedIds,
    truncated:     changed.truncated,
  };
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono().basePath('/teambrain-staleness');

app.post('/scan', async (c) => {
  try {
    requireServiceRole(c.req.header('authorization') ?? c.req.header('Authorization') ?? null);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const service = serviceClient();

  // Optional single-project scan via body { project_slug }.
  let onlySlug: string | null = null;
  try {
    const body = await c.req.json();
    if (body && typeof body.project_slug === 'string') onlySlug = body.project_slug;
  } catch {
    // empty/invalid body → scan all (the pg_cron path posts `{}`)
  }

  let query = service.from('projects').select('id, repo_slug').not('repo_slug', 'is', null);
  if (onlySlug) query = query.eq('repo_slug', onlySlug);
  const { data: projects, error: listErr } = await query;
  if (listErr) return c.json({ error: `projects list failed: ${listErr.message}` }, 500);

  let token: string;
  try {
    token = await getInstallationToken();
  } catch (err) {
    return c.json({ error: `github token mint failed: ${(err as Error).message}` }, 502);
  }

  const results: ProjectScanReport[] = [];
  for (const project of (projects ?? []) as ProjectRow[]) {
    try {
      results.push(await scanProject(service, token, project));
    } catch (err) {
      results.push({ project_slug: project.repo_slug ?? '(unknown)', error: (err as Error).message });
    }
  }

  return c.json({
    service:     'teambrain-staleness',
    scanned:     results.length,
    flagged:     results.reduce((n, r) => n + (r.flagged ?? 0), 0),
    results,
    checked_at:  new Date().toISOString(),
  });
});

app.get('/health', async (c) => {
  const service = serviceClient();
  const { data, error } = await service
    .from('staleness_poll_state')
    .select('project_id, last_sha, last_polled_at');
  if (error) {
    return c.json({ service: 'teambrain-staleness', status: 'unknown', error: error.message }, 503);
  }

  const rows = (data ?? []) as { project_id: string; last_sha: string | null; last_polled_at: string | null }[];
  const hourAgo = Date.now() - 60 * 60 * 1000;
  // Healthy unless a project that has been polled before has now gone >1h stale.
  const stale = rows.filter((r) => r.last_polled_at !== null && Date.parse(r.last_polled_at) < hourAgo);
  const ok = stale.length === 0;

  return c.json({
    service:    'teambrain-staleness',
    status:     ok ? 'ok' : 'stale',
    projects:   rows.length,
    stale:      stale.length,
    checked_at: new Date().toISOString(),
  }, ok ? 200 : 503);
});

app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
