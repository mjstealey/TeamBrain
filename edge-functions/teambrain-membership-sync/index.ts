// teambrain-membership-sync/index.ts — Phase 3 background reconciler.
//
// Two HTTP endpoints, both service-role-authenticated:
//
//   POST /sync?project_slug=<slug>     — sync one project, return SyncReport.
//   POST /sync-all                     — sync every row in public.projects,
//                                        called by pg_cron every 15 min.
//
// This function is **not** an MCP server. It exposes no tools, no
// per-user RLS surface — every read/write happens via the service-role
// client because membership changes (insert/update/tombstone of
// project_members rows) have no policy permitting `authenticated`.
// That asymmetry vs. the MCP function is intentional: writes that
// only service_role is permitted to make should only be invokable
// from a service-role-authenticated path.
//
// Auth model:
//   * The supabase docker stack sets VERIFY_JWT=true on the functions
//     container, so every request entering this worker has a JWT
//     validated by the dispatcher (`functions/main/index.ts`) against
//     the GoTrue JWKS endpoint.
//   * We assert the JWT's `role` claim is `service_role`. Anything
//     else (anon, authenticated) is rejected with 403. The dispatcher
//     does not enforce role gating on its own — that's our job here.
//
// The function persists every invocation to public.sync_runs:
//   * /sync writes one row tied to the project being synced.
//   * /sync-all writes one project_id=NULL aggregate row plus one row
//     per project. The aggregate captures the run-level success state
//     (did the loop complete?) and is the row pg_cron's
//     job_run_details surfaces back via net.http_post.

import { Hono } from 'npm:hono@^4.6.0';
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';

import { syncOneProject, SyncReport } from './sync.ts';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'teambrain-membership-sync: missing SUPABASE_URL or ' +
    'SUPABASE_SERVICE_ROLE_KEY at boot',
  );
}

// One module-scoped service-role client. Persists across requests on
// the same worker; the supabase-js client is internally stateless for
// our usage (no realtime, no auth subscriptions).
function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });
}

// ---------------------------------------------------------------------------
// JWT role assertion
// ---------------------------------------------------------------------------

// The dispatcher already validated the JWT signature; we read claims
// without re-verifying. Same justification as the MCP function's
// `jwtSub`: signature verification is not this worker's job.
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
  if (!authHeader) {
    throw new HttpError(401, 'Authorization header required');
  }
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

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// sync_runs persistence
// ---------------------------------------------------------------------------

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
  if (error) {
    // Log but do not throw — failure to record an audit row should not
    // mask the underlying sync result. Operators see this in container
    // logs; the next /sync-all invocation will succeed if the cause
    // was transient.
    console.error(`sync_runs insert failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

// The supabase Edge Runtime dispatcher forwards requests into the
// worker with the function name still in the path — i.e. an inbound
// request to `/functions/v1/teambrain-membership-sync/sync` arrives
// here as `/teambrain-membership-sync/sync`, not `/sync`. `basePath`
// strips the prefix so the route definitions read naturally.
//
// Both routes handle POST only — GET is a no-op (intentional, to
// avoid accidental triggering via browser navigation).

const app = new Hono().basePath('/teambrain-membership-sync');

app.post('/sync', async (c) => {
  try {
    requireServiceRole(c.req.header('authorization') ?? c.req.header('Authorization') ?? null);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const slug = c.req.query('project_slug');
  if (!slug) {
    return c.json({ error: 'project_slug query parameter required' }, 400);
  }

  const service = serviceClient();
  const startedAt = new Date().toISOString();

  // Resolve slug → projects row (including the github_team_slugs we need).
  const { data: projectRow, error: projErr } = await service
    .from('projects')
    .select('id, repo_slug, github_team_slugs')
    .eq('repo_slug', slug)
    .maybeSingle();
  if (projErr) {
    await recordRun(service, {
      project_id:  null,
      started_at:  startedAt,
      finished_at: new Date().toISOString(),
      ok:          false,
      report:      null,
      error:       `project lookup failed: ${projErr.message}`,
    });
    return c.json({ error: `project lookup failed: ${projErr.message}` }, 500);
  }
  if (!projectRow) {
    return c.json({ error: `project not found: ${slug}` }, 404);
  }

  let report: SyncReport;
  try {
    report = await syncOneProject(service, {
      project_id:        projectRow.id,
      repo_slug:         projectRow.repo_slug,
      github_team_slugs: projectRow.github_team_slugs ?? [],
    });
  } catch (err) {
    const message = (err as Error).message;
    await recordRun(service, {
      project_id:  projectRow.id,
      started_at:  startedAt,
      finished_at: new Date().toISOString(),
      ok:          false,
      report:      null,
      error:       message,
    });
    return c.json({ error: message }, 500);
  }

  await recordRun(service, {
    project_id:  projectRow.id,
    started_at:  startedAt,
    finished_at: new Date().toISOString(),
    ok:          true,
    report,
    error:       null,
  });

  return c.json(report);
});

app.post('/sync-all', async (c) => {
  try {
    requireServiceRole(c.req.header('authorization') ?? c.req.header('Authorization') ?? null);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  const service = serviceClient();
  const aggregateStartedAt = new Date().toISOString();

  const { data: projects, error: listErr } = await service
    .from('projects')
    .select('id, repo_slug, github_team_slugs');
  if (listErr) {
    await recordRun(service, {
      project_id:  null,
      started_at:  aggregateStartedAt,
      finished_at: new Date().toISOString(),
      ok:          false,
      report:      null,
      error:       `projects list failed: ${listErr.message}`,
    });
    return c.json({ error: `projects list failed: ${listErr.message}` }, 500);
  }

  const reports: Array<{ project_slug: string; ok: boolean; error?: string; report?: SyncReport }> = [];

  for (const p of projects ?? []) {
    const startedAt = new Date().toISOString();
    try {
      const report = await syncOneProject(service, {
        project_id:        p.id,
        repo_slug:         p.repo_slug,
        github_team_slugs: p.github_team_slugs ?? [],
      });
      await recordRun(service, {
        project_id:  p.id,
        started_at:  startedAt,
        finished_at: new Date().toISOString(),
        ok:          true,
        report,
        error:       null,
      });
      reports.push({ project_slug: p.repo_slug, ok: true, report });
    } catch (err) {
      const message = (err as Error).message;
      await recordRun(service, {
        project_id:  p.id,
        started_at:  startedAt,
        finished_at: new Date().toISOString(),
        ok:          false,
        report:      null,
        error:       message,
      });
      reports.push({ project_slug: p.repo_slug, ok: false, error: message });
    }
  }

  const aggregate = {
    projects:     reports.length,
    succeeded:    reports.filter((r) => r.ok).length,
    failed:       reports.filter((r) => !r.ok).length,
    per_project:  reports,
  };
  const allOk = aggregate.failed === 0;

  await recordRun(service, {
    project_id:  null,                 // aggregate row
    started_at:  aggregateStartedAt,
    finished_at: new Date().toISOString(),
    ok:          allOk,
    report:      aggregate,
    error:       allOk ? null : `${aggregate.failed} of ${aggregate.projects} project syncs failed`,
  });

  return c.json(aggregate, allOk ? 200 : 500);
});

// Catch-all 404 — keeps method/path mismatches from surfacing as
// generic 500s and gives operators a clear "you hit the wrong route".
app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
