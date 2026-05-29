// teambrain-rest/index.ts — Phase 4 REST surface for TeamBrain.
//
// A plain HTTP/JSON mirror of the MCP tool set (`teambrain-mcp`), for
// clients that aren't MCP-native: curl, OpenAI/gemini function calling,
// GitHub Actions, CI. Same backend, same RLS, same GitHub-OAuth JWT.
//
// Auth model (identical to teambrain-mcp): the dispatcher (functions/main)
// validates the JWT against GoTrue's JWKS when VERIFY_JWT=true and forwards
// the Authorization header intact. We do NOT re-verify here. Every request
// builds a per-request `userClient` (ANON_KEY + the caller's forwarded
// JWT); PostgREST reads request.jwt.claims, RLS uses auth.uid(), and the
// caller sees only the rows their policies permit. No application-layer
// access checks live in this file.
//
// Why a separate function rather than PostgREST (decision A1 in
// docs/phase-4-checklist.md): the published OpenAPI is meant for LLM
// tool-callers and CI; PostgREST's auto-generated surface (every table,
// column, filter operator, Prefer headers) is the wrong contract to hand
// them. This function is the curated, slug-friendly surface; PostgREST
// stays available underneath for admin/power use, undocumented.
//
// Reuses embedding.ts from teambrain-mcp (relative import; both functions
// mount under the same Edge Runtime root). The ~tiny jwtSub/resolveProjectId
// helpers are duplicated rather than extracted — consistent with the rest
// of the codebase, where each function carries its own JWT decode.

import { Hono }                            from 'npm:hono@^4.6.0';
import { z }                               from 'npm:zod@^3.23.0';
import { createClient, SupabaseClient }    from 'npm:@supabase/supabase-js@^2.45.0';

import { embed, vectorLiteral, currentEmbeddingModelTag } from '../teambrain-mcp/embedding.ts';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('teambrain-rest: missing SUPABASE_URL or SUPABASE_ANON_KEY at boot');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// Per-request auth context (RLS = auth)
// ---------------------------------------------------------------------------

interface AuthContext {
  userClient: SupabaseClient;
  userId:     string;     // auth.uid() — the JWT's `sub` claim
  caps:       TokenCaps;  // API-token capability claims (absent ⇒ a human JWT)
}

// Capability claims carried by an exchanged API-token JWT (teambrain-token).
// Absent on human GitHub-OAuth JWTs, in which case isToken=false and the
// guards are inert. RLS (migration 0012) is the real boundary — these checks
// just return clear errors instead of opaque RLS denials / silent empties.
interface TokenCaps {
  isToken:       boolean;
  allowedTools:  string[];
  allowedScopes: string[];
}

// Decode the JWT payload's `sub` without re-verifying the signature (the
// dispatcher already verified it). Same justification as teambrain-mcp.
function jwtSub(authHeader: string): string {
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'JWT not in three-segment form');
  const padded  = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    throw new HttpError(401, 'JWT payload is not valid base64url JSON');
  }
  if (typeof payload.sub !== 'string') throw new HttpError(401, 'JWT missing `sub` claim');
  return payload.sub;
}

// Decode the API-token capability claims (no re-verify; same trust model as
// jwtSub). Returns isToken=false for a human JWT or any decode hiccup.
function tokenCaps(authHeader: string): TokenCaps {
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return { isToken: false, allowedTools: [], allowedScopes: [] };
  let payload: Record<string, unknown>;
  try {
    const padded = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
    payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return { isToken: false, allowedTools: [], allowedScopes: [] };
  }
  if (payload.teambrain_token !== true) return { isToken: false, allowedTools: [], allowedScopes: [] };
  return {
    isToken:       true,
    allowedTools:  Array.isArray(payload.teambrain_allowed_tools)  ? payload.teambrain_allowed_tools  as string[] : [],
    allowedScopes: Array.isArray(payload.teambrain_allowed_scopes) ? payload.teambrain_allowed_scopes as string[] : [],
  };
}

function requireAuth(authHeader: string | null): AuthContext {
  if (!authHeader) throw new HttpError(401, 'Authorization header required');
  return {
    userClient: createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false, autoRefreshToken: false },
      db:     { schema: 'public' },
    }),
    userId: jwtSub(authHeader),
    caps:   tokenCaps(authHeader),
  };
}

// Reject an endpoint when the caller's API token does not list its MCP tool
// name. Inert for human JWTs (isToken=false). The `ping`/`health` diagnostic
// is intentionally not gated.
function requireToolAllowed(caps: TokenCaps, tool: string): void {
  if (caps.isToken && !caps.allowedTools.includes(tool)) {
    throw new HttpError(403, `not permitted for this API token (tool "${tool}"); allowed: ${JSON.stringify(caps.allowedTools)}`);
  }
}

// Clamp requested scopes to the token's allowed set (RLS still enforces).
// For a token, an empty result ⇒ caller asked only for scopes it cannot see.
function tokenScopes(caps: TokenCaps, requested: string[] | undefined): string[] {
  if (!requested || requested.length === 0) return caps.allowedScopes;
  return requested.filter((s) => caps.allowedScopes.includes(s));
}

// ---------------------------------------------------------------------------
// Project-slug → project-id resolution (RLS-filtered; never leaks existence)
// ---------------------------------------------------------------------------

async function resolveProjectId(
  userClient: SupabaseClient,
  slug:       string | undefined,
): Promise<{ projectId: string; slug: string }> {
  const effective = slug ?? Deno.env.get('TEAMBRAIN_DEFAULT_PROJECT_SLUG');
  if (!effective) {
    throw new HttpError(400, 'project_slug not provided and TEAMBRAIN_DEFAULT_PROJECT_SLUG not set on the server');
  }
  const { data, error } = await userClient
    .from('projects')
    .select('id')
    .eq('repo_slug', effective)
    .maybeSingle();
  if (error)  throw new HttpError(500, `project lookup failed: ${error.message}`);
  if (!data)  throw new HttpError(404, `project not found or not accessible to caller: ${effective}`);
  return { projectId: (data as { id: string }).id, slug: effective };
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ');
    throw new HttpError(400, `validation failed: ${msg}`);
  }
  return r.data;
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
}

const SCOPE  = z.enum(['personal', 'project', 'project_private']);
const TYPE   = z.enum(['decision', 'convention', 'gotcha', 'context', 'preference', 'runbook']);

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono().basePath('/teambrain-rest');

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error('teambrain-rest unhandled error:', err);
  return c.json({ error: (err as Error).message ?? 'internal error' }, 500);
});

// --- GET /health (mirrors `ping`) ------------------------------------------
app.get('/health', async (c) => {
  const { userClient, userId } = requireAuth(c.req.header('Authorization') ?? null);
  const { error, count } = await userClient
    .from('thoughts')
    .select('id', { count: 'exact', head: true });
  if (error) throw new HttpError(502, `health probe failed: ${error.message} (code=${error.code ?? 'n/a'})`);
  return c.json({
    service:              'teambrain-rest',
    version:              '0.1.0',
    uid:                  userId,
    visible_thought_rows: count ?? 0,
    checked_at:           new Date().toISOString(),
  });
});

// --- POST /thoughts (mirrors `capture_project_thought`) --------------------
const CaptureBody = z.object({
  content:           z.string().min(1).max(10_000),
  scope:             SCOPE.default('project'),
  type:              TYPE.optional(),
  project_slug:      z.string().optional(),
  tags:              z.array(z.string()).default([]),
  paths:             z.array(z.string()).default([]),
  linked_commit_sha: z.string().optional(),
  linked_pr_url:     z.string().optional(),
  linked_issue_url:  z.string().optional(),
});

app.post('/thoughts', async (c) => {
  const { userClient, userId, caps } = requireAuth(c.req.header('Authorization') ?? null);
  requireToolAllowed(caps, 'capture_project_thought');
  const body = parse(CaptureBody, await jsonBody(c));

  if (caps.isToken && !caps.allowedScopes.includes(body.scope)) {
    throw new HttpError(403, `scope "${body.scope}" not permitted for this API token; allowed: ${JSON.stringify(caps.allowedScopes)}`);
  }

  // Resolve project context (skip for personal — CHECK requires project_id NULL).
  let projectId: string | null = null;
  let resolvedSlug: string | null = null;
  if (body.scope !== 'personal') {
    const r = await resolveProjectId(userClient, body.project_slug);
    projectId    = r.projectId;
    resolvedSlug = r.slug;
  }

  let embedding: number[];
  try {
    embedding = await embed(body.content);
  } catch (e) {
    throw new HttpError(502, `embedding failed: ${(e as Error).message}`);
  }

  const { data, error } = await userClient
    .from('thoughts')
    .insert({
      content:           body.content,
      scope:             body.scope,
      type:              body.type ?? null,
      project_id:        projectId,
      author_user_id:    userId,
      embedding:         vectorLiteral(embedding),
      embedding_model:   currentEmbeddingModelTag(),
      tags:              body.tags,
      paths:             body.paths,
      linked_commit_sha: body.linked_commit_sha ?? null,
      linked_pr_url:     body.linked_pr_url     ?? null,
      linked_issue_url:  body.linked_issue_url  ?? null,
    })
    .select('id, scope, type, project_id, created_at, embedding_model')
    .single();

  if (error) {
    // RLS WITH CHECK denial (caller not a writer) surfaces as an error here.
    throw new HttpError(403, `capture denied or failed: ${error.message} (code=${error.code ?? 'n/a'})`);
  }

  const row = data as {
    id: string; scope: string; type: string | null;
    project_id: string | null; created_at: string; embedding_model: string | null;
  };
  return c.json({
    id:              row.id,
    scope:           row.scope,
    type:            row.type,
    project_slug:    resolvedSlug,
    project_id:      row.project_id,
    created_at:      row.created_at,
    content_chars:   body.content.length,
    embedding_dims:  embedding.length,
    embedding_model: row.embedding_model,
  }, 201);
});

// --- POST /thoughts/search (mirrors `search_project_thoughts`) -------------
const SearchBody = z.object({
  query:         z.string().min(1).max(2_000),
  project_slug:  z.string().optional(),
  scopes:        z.array(SCOPE).optional(),
  limit:         z.number().int().min(1).max(50).default(10),
  threshold:     z.number().min(0).max(1).default(0.3),
  cross_project: z.boolean().default(false),
});

app.post('/thoughts/search', async (c) => {
  const { userClient, caps } = requireAuth(c.req.header('Authorization') ?? null);
  requireToolAllowed(caps, 'search_project_thoughts');
  const body = parse(SearchBody, await jsonBody(c));

  let filterProjectId: string | null = null;
  let resolvedSlug:    string | null = null;
  if (!body.cross_project) {
    const r = await resolveProjectId(userClient, body.project_slug);
    filterProjectId = r.projectId;
    resolvedSlug    = r.slug;
  }

  let queryVec: number[];
  try {
    queryVec = await embed(body.query);
  } catch (e) {
    throw new HttpError(502, `embedding failed: ${(e as Error).message}`);
  }

  const { data, error } = await userClient.rpc('match_thoughts', {
    query_embedding:   vectorLiteral(queryVec),
    match_count:       body.limit,
    match_threshold:   body.threshold,
    filter_project_id: filterProjectId,
    filter_scopes:     caps.isToken ? tokenScopes(caps, body.scopes) : (body.scopes ?? null),
  });
  if (error) throw new HttpError(502, `search failed: ${error.message} (code=${error.code ?? 'n/a'})`);

  const rows = (data ?? []) as Array<{
    id: string; content: string; scope: string; type: string | null;
    project_id: string | null; author_user_id: string | null; similarity: number;
    created_at: string; last_verified_at: string | null; tags: string[];
  }>;

  return c.json({
    query:         body.query,
    project_slug:  resolvedSlug,
    cross_project: body.cross_project,
    threshold:     body.threshold,
    count:         rows.length,
    results: rows.map((r) => ({
      id:               r.id,
      similarity:       Number(r.similarity.toFixed(4)),
      scope:            r.scope,
      type:             r.type,
      project_id:       r.project_id,
      author_user_id:   r.author_user_id,
      created_at:       r.created_at,
      last_verified_at: r.last_verified_at,
      tags:             r.tags,
      content:          r.content,
    })),
  });
});

// --- GET /thoughts (mirrors `list_recent_project_thoughts`) ----------------
// Query params: project_slug, scopes (comma-separated), limit, since, cross_project.
const ListQuery = z.object({
  project_slug:  z.string().optional(),
  scopes:        z.array(SCOPE).optional(),
  limit:         z.number().int().min(1).max(100).default(20),
  since:         z.string().optional(),
  cross_project: z.boolean().default(false),
});

app.get('/thoughts', async (c) => {
  const { userClient, caps } = requireAuth(c.req.header('Authorization') ?? null);
  requireToolAllowed(caps, 'list_recent_project_thoughts');

  const scopesRaw = c.req.query('scopes');
  const raw = {
    project_slug:  c.req.query('project_slug') || undefined,
    scopes:        scopesRaw ? scopesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    limit:         c.req.query('limit')  ? Number(c.req.query('limit'))  : undefined,
    since:         c.req.query('since')  || undefined,
    cross_project: c.req.query('cross_project') === 'true',
  };
  const q = parse(ListQuery, raw);

  let filterProjectId: string | null = null;
  let resolvedSlug:    string | null = null;
  if (!q.cross_project) {
    const r = await resolveProjectId(userClient, q.project_slug);
    filterProjectId = r.projectId;
    resolvedSlug    = r.slug;
  }

  let query = userClient
    .from('thoughts')
    .select('id, scope, type, project_id, author_user_id, content, tags, paths, ' +
            'confidence, created_at, last_verified_at, expires_at')
    .order('created_at', { ascending: false })
    .limit(q.limit);

  if (filterProjectId)       query = query.eq('project_id', filterProjectId);
  if (caps.isToken)          query = query.in('scope', tokenScopes(caps, q.scopes));
  else if (q.scopes?.length) query = query.in('scope', q.scopes);
  if (q.since)               query = query.gt('created_at', q.since);

  const { data, error } = await query;
  if (error) throw new HttpError(502, `list failed: ${error.message} (code=${error.code ?? 'n/a'})`);

  return c.json({
    project_slug:  resolvedSlug,
    cross_project: q.cross_project,
    count:         (data ?? []).length,
    results:       data ?? [],
  });
});

// --- PATCH /thoughts/:id/stale (mirrors `mark_stale`) ----------------------
const StaleBody = z.object({
  confidence: z.enum(['tentative', 'deprecated']).default('deprecated'),
  reason:     z.string().optional(),
});

app.patch('/thoughts/:id/stale', async (c) => {
  const { userClient, caps } = requireAuth(c.req.header('Authorization') ?? null);
  requireToolAllowed(caps, 'mark_stale');
  const id = parse(z.string().uuid(), c.req.param('id'));
  // Body is optional; default to {} so PATCH with no body still works.
  const rawBody = c.req.header('content-length') && c.req.header('content-length') !== '0'
    ? await jsonBody(c)
    : {};
  const body = parse(StaleBody, rawBody);

  const { data, error } = await userClient
    .from('thoughts')
    .update({ confidence: body.confidence, last_verified_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, confidence, last_verified_at')
    .maybeSingle();

  if (error) throw new HttpError(502, `mark_stale failed: ${error.message} (code=${error.code ?? 'n/a'})`);

  if (!data) {
    // Row missing OR RLS blocked the update — do not distinguish (the
    // distinction would itself leak existence).
    return c.json({
      updated:    false,
      thought_id: id,
      reason:     'thought not found, or caller lacks update permission',
    });
  }

  const row = data as { id: string; confidence: string; last_verified_at: string };
  return c.json({
    updated:          true,
    id:               row.id,
    new_confidence:   row.confidence,
    last_verified_at: row.last_verified_at,
    reason_received:  body.reason ?? null,
  });
});

// --- POST /thoughts/:id/promote (mirrors `promote_to_docs`, preview only) --
const PromoteBody = z.object({
  target_path:   z.string().default('docs/adr/'),
  target_branch: z.string().default('main'),
});

app.post('/thoughts/:id/promote', async (c) => {
  const { userClient, caps } = requireAuth(c.req.header('Authorization') ?? null);
  requireToolAllowed(caps, 'promote_to_docs');
  const id = parse(z.string().uuid(), c.req.param('id'));
  const rawBody = c.req.header('content-length') && c.req.header('content-length') !== '0'
    ? await jsonBody(c)
    : {};
  const body = parse(PromoteBody, rawBody);

  const { data, error } = await userClient
    .from('thoughts')
    .select('id, scope, type, content, project_id, author_user_id, tags, paths, ' +
            'linked_commit_sha, linked_pr_url, linked_issue_url, created_at, last_verified_at')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new HttpError(502, `promote preview failed: ${error.message} (code=${error.code ?? 'n/a'})`);
  if (!data) {
    return c.json({ ok: false, thought_id: id, reason: 'thought not found, or caller lacks read permission' });
  }

  const t = data as {
    id: string; scope: string; type: string | null; content: string;
    project_id: string | null; author_user_id: string | null;
    tags: string[]; paths: string[]; linked_commit_sha: string | null;
    linked_pr_url: string | null; linked_issue_url: string | null;
    created_at: string; last_verified_at: string | null;
  };

  const filename = `${t.id.slice(0, 8)}-${(t.type ?? 'thought')}.md`;
  const branch   = `teambrain/promote-${t.id.slice(0, 8)}`;
  const md = [
    `# ${t.type ?? 'Thought'}: ${t.content.split('\n')[0].slice(0, 80)}`,
    '',
    `> Promoted from TeamBrain thought \`${t.id}\` on ${new Date().toISOString()}.`,
    '',
    '## Content',
    '',
    t.content,
    '',
    '## Provenance',
    '',
    `- scope: \`${t.scope}\``,
    `- captured: ${t.created_at}`,
    t.last_verified_at ? `- last verified: ${t.last_verified_at}` : null,
    t.linked_commit_sha ? `- linked commit: \`${t.linked_commit_sha}\`` : null,
    t.linked_pr_url     ? `- linked PR: ${t.linked_pr_url}`            : null,
    t.linked_issue_url  ? `- linked issue: ${t.linked_issue_url}`      : null,
    t.paths.length > 0  ? `- paths: ${t.paths.map((p) => '`' + p + '`').join(', ')}` : null,
    t.tags.length  > 0  ? `- tags: ${t.tags.map((p)  => '`' + p + '`').join(', ')}`  : null,
  ].filter((x) => x !== null).join('\n');

  return c.json({
    ok:      true,
    preview: true,
    note:    'Preview only — no PR was created. Phase 6 will wire the GitHub API.',
    request: {
      thought_id:         t.id,
      target_path:        body.target_path,
      target_branch:      body.target_branch,
      proposed_branch:    branch,
      proposed_filename:  filename,
      proposed_full_path: body.target_path.replace(/\/?$/, '/') + filename,
    },
    commit_payload: { filename, markdown: md },
  });
});

// Catch-all — clear 404 for path/method mismatches.
app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
