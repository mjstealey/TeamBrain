// teambrain-token/index.ts — Phase 5 § A2: long-lived, non-interactive API
// tokens (the gating item for the PR-merge GitHub Action).
//
// Model — a refresh/access split (docs/development/phase-5-checklist.md § A):
//   * The OPAQUE token (`tbk_<base64url(32 bytes)>`) is the durable,
//     revocable credential. It is stored ONLY as a SHA-256 hash; the
//     plaintext is returned once, at issuance, and never persisted.
//   * `POST /token/exchange` swaps a valid opaque token for a short-lived
//     (15 min) HS256 JWT minted for the project's bot user. That JWT drives
//     the existing MCP/REST surface through the existing RLS — the 0012
//     capability fence keys off its `teambrain_token` claim.
//
// Routes (mounted under the function name by the Edge Runtime dispatcher):
//   POST   /token            — issue a token (project-admin gated)
//   GET    /token?project=…  — list a project's tokens (admin; metadata only)
//   POST   /token/:id/revoke — soft-revoke (admin)
//   POST   /token/exchange   — opaque token -> minted access-token JWT
//
// Auth shapes:
//   * The three admin routes take a GitHub-OAuth *user* JWT in
//     `Authorization` and trust the dispatcher's signature check, exactly as
//     teambrain-register-project does (so they are only as strong as
//     VERIFY_JWT=true on the dispatcher — the production posture). Authz is
//     the project-admin gate, enforced here via service_role.
//   * `/token/exchange` does NOT need a verified user JWT: its credential is
//     the opaque token in the `X-TeamBrain-Token` header, validated against
//     the hash table server-side. To satisfy a dispatcher running
//     VERIFY_JWT=true, the caller sends the *public* ANON_KEY as the
//     `Authorization` bearer (a valid JWT, not a secret); this function
//     ignores it. Works whether VERIFY_JWT is on or off.
//
// FENCE INVARIANT (load-bearing — see § A4 review): the per-project bot is
// created with NO password and NO linked identity, under the non-routable
// `@teambrain.local` domain. It therefore has no interactive / OTP / magic
// link login path — the ONLY way to obtain a JWT for the bot is this
// exchange, which always stamps `teambrain_token: true`. If the bot could
// ever acquire a claim-less `authenticated` JWT, it would (as a contributor)
// bypass the 0012 fence. Do not give the bot a credential.

import { Hono }                          from 'npm:hono@^4.6.0';
import type { ContentfulStatusCode }    from 'npm:hono@^4.6.0/utils/http-status';
import { createClient, SupabaseClient }  from 'npm:@supabase/supabase-js@^2.45.0';
import { SignJWT }                       from 'npm:jose@^5.9.0';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// The Edge Runtime dispatcher (functions/main) forwards the whole container
// env to each worker, and reads JWT_SECRET itself — so it is present here.
// Guard at boot anyway; /token/exchange cannot mint without it.
const JWT_SECRET                = Deno.env.get('JWT_SECRET');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('teambrain-token: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY at boot');
}
if (!JWT_SECRET) {
  console.error('teambrain-token: missing JWT_SECRET — /token/exchange cannot mint access tokens until it is set');
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;   // bounds revocation latency

const KNOWN_SCOPES = ['personal', 'project', 'project_private'];
const KNOWN_TOOLS  = [
  'ping',
  'capture_project_thought',
  'search_project_thoughts',
  'list_recent_project_thoughts',
  'mark_stale',
  'promote_to_docs',
];
// Defaults match the Phase 5 decision: capture + read, no project_private.
const DEFAULT_TOOLS  = [
  'capture_project_thought',
  'search_project_thoughts',
  'list_recent_project_thoughts',
];
const DEFAULT_SCOPES = ['project', 'personal'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });
}

// ---------------------------------------------------------------------------
// Auth helpers (admin routes) — decode only; dispatcher verified the signature
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

// Require a GitHub-OAuth user token and return the caller's auth.uid().
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
// Crypto helpers
// ---------------------------------------------------------------------------

function randomOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `tbk_${b64url}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Project + admin resolution (service_role)
// ---------------------------------------------------------------------------

interface ProjectRow { id: string; repo_slug: string; name: string; bot_user_id: string | null; }

async function resolveProject(service: SupabaseClient, slug: string): Promise<ProjectRow | null> {
  const { data, error } = await service
    .from('projects')
    .select('id, repo_slug, name, bot_user_id')
    .eq('repo_slug', slug)
    .maybeSingle();
  if (error) throw new HttpError(500, `project lookup failed: ${error.message}`);
  return (data as ProjectRow | null) ?? null;
}

async function requireProjectAdmin(service: SupabaseClient, projectId: string, userId: string): Promise<void> {
  const { data, error } = await service
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .is('removed_at', null)
    .maybeSingle();
  if (error) throw new HttpError(500, `membership lookup failed: ${error.message}`);
  if (!data || (data as { role: string }).role !== 'admin') {
    throw new HttpError(403, 'project admin role required to manage API tokens');
  }
}

// ---------------------------------------------------------------------------
// Per-project bot provisioning (lazy, idempotent)
// ---------------------------------------------------------------------------

async function findUserIdByEmail(service: SupabaseClient, email: string): Promise<string | null> {
  // GoTrue admin API has no email filter; scan paginated (pilot-scale auth.users
  // is tiny — same defensive loop as membership-sync's listAllAuthUsers).
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new HttpError(500, `auth listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    const match = users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (users.length < 1000) break;
  }
  return null;
}

async function ensureBotUser(service: SupabaseClient, project: ProjectRow): Promise<string> {
  if (project.bot_user_id) return project.bot_user_id;

  // No password, no identity, non-routable domain => no login path (fence invariant).
  const email = `bot+${project.id}@teambrain.local`;
  let botUserId: string | null;
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { teambrain_bot: true, project_id: project.id, project_slug: project.repo_slug },
    app_metadata:  { teambrain_bot: true },
  });
  if (createErr) {
    // Recover a prior partial provision (user created but bot_user_id not stamped).
    botUserId = await findUserIdByEmail(service, email);
    if (!botUserId) throw new HttpError(500, `bot user provisioning failed: ${createErr.message}`);
  } else {
    botUserId = created.user.id;
  }

  const { error: stampErr } = await service
    .from('projects')
    .update({ bot_user_id: botUserId })
    .eq('id', project.id);
  if (stampErr) throw new HttpError(500, `failed to record bot_user_id: ${stampErr.message}`);

  const { error: memErr } = await service
    .from('project_members')
    .upsert(
      { project_id: project.id, user_id: botUserId, role: 'contributor', is_service_account: true, removed_at: null },
      { onConflict: 'project_id,user_id' },
    );
  if (memErr) throw new HttpError(500, `failed to seed bot membership: ${memErr.message}`);

  return botUserId;
}

// ---------------------------------------------------------------------------
// Access-token minting
// ---------------------------------------------------------------------------

interface TokenRow {
  id:                string;
  principal_user_id: string;
  project_id:        string;
  allowed_tools:     string[];
  allowed_scopes:    string[];
}

// Mint a GoTrue-shaped HS256 access token for the bot. PostgREST verifies the
// signature against JWT_SECRET and switches to the `authenticated` role from
// the `role` claim; `auth.uid()` reads `sub`. The teambrain_* claims drive the
// 0012 fence + the MCP/REST capability guard.
async function mintAccessToken(tok: TokenRow): Promise<string> {
  if (!JWT_SECRET) throw new HttpError(500, 'server misconfigured: JWT_SECRET not set');
  const secret = new TextEncoder().encode(JWT_SECRET);
  const now    = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    role:                     'authenticated',
    teambrain_token:          true,
    teambrain_token_id:       tok.id,
    teambrain_project_id:     tok.project_id,
    teambrain_allowed_tools:  tok.allowed_tools,
    teambrain_allowed_scopes: tok.allowed_scopes,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(tok.principal_user_id)
    .setAudience('authenticated')
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secret);
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono().basePath('/teambrain-token');

// Centralized error mapping — handlers just throw HttpError.
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error('teambrain-token unhandled error:', err);
  return c.json({ error: 'internal error' }, 500);
});

interface CreateBody {
  project_slug?:    unknown;
  name?:            unknown;
  allowed_tools?:   unknown;
  allowed_scopes?:  unknown;
  expires_in_days?: unknown;
}

// POST /token — issue a token for a project (admin only). Returns the
// plaintext ONCE; only its hash is stored.
app.post('/token', async (c) => {
  const callerUserId = requireUser(c.req.header('authorization') ?? null);

  let body: CreateBody;
  try { body = await c.req.json() as CreateBody; }
  catch { throw new HttpError(400, 'request body must be JSON'); }

  const slug = typeof body.project_slug === 'string' ? body.project_slug.trim() : '';
  if (!slug) throw new HttpError(400, 'project_slug required (format "owner/repo")');

  const service = serviceClient();
  const project = await resolveProject(service, slug);
  if (!project) throw new HttpError(404, `project not found: ${slug}`);
  await requireProjectAdmin(service, project.id, callerUserId);

  let allowedTools  = DEFAULT_TOOLS;
  let allowedScopes = DEFAULT_SCOPES;
  if (body.allowed_tools !== undefined) {
    if (!Array.isArray(body.allowed_tools) || !body.allowed_tools.every((t) => KNOWN_TOOLS.includes(t as string))) {
      throw new HttpError(400, `allowed_tools must be a subset of ${JSON.stringify(KNOWN_TOOLS)}`);
    }
    allowedTools = body.allowed_tools as string[];
  }
  if (body.allowed_scopes !== undefined) {
    if (!Array.isArray(body.allowed_scopes) || !body.allowed_scopes.every((s) => KNOWN_SCOPES.includes(s as string))) {
      throw new HttpError(400, `allowed_scopes must be a subset of ${JSON.stringify(KNOWN_SCOPES)}`);
    }
    allowedScopes = body.allowed_scopes as string[];
  }

  const botUserId = await ensureBotUser(service, project);

  const plaintext   = randomOpaqueToken();
  const tokenHash   = await sha256Hex(plaintext);
  const tokenPrefix = plaintext.slice(0, 14);
  const name        = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : null;

  const insertRow: Record<string, unknown> = {
    token_hash:        tokenHash,
    token_prefix:      tokenPrefix,
    principal_user_id: botUserId,
    project_id:        project.id,
    allowed_tools:     allowedTools,
    allowed_scopes:    allowedScopes,
    name,
    created_by:        callerUserId,
  };
  if (typeof body.expires_in_days === 'number' && body.expires_in_days > 0) {
    insertRow.expires_at = new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString();
  }

  const { data: row, error } = await service
    .from('api_tokens')
    .insert(insertRow)
    .select('id, token_prefix, project_id, allowed_tools, allowed_scopes, name, created_at, expires_at')
    .single();
  if (error) throw new HttpError(500, `token insert failed: ${error.message}`);

  return c.json({
    token:          plaintext,
    note:           'Store this now — it is shown ONLY once and cannot be retrieved later.',
    id:             row.id,
    token_prefix:   row.token_prefix,
    project_slug:   project.repo_slug,
    allowed_tools:  row.allowed_tools,
    allowed_scopes: row.allowed_scopes,
    name:           row.name,
    created_at:     row.created_at,
    expires_at:     row.expires_at,
  }, 201);
});

// GET /token?project=owner/repo — list a project's tokens (admin only).
// Metadata only; never the hash or plaintext.
app.get('/token', async (c) => {
  const callerUserId = requireUser(c.req.header('authorization') ?? null);

  const slug = (c.req.query('project') ?? '').trim();
  if (!slug) throw new HttpError(400, 'query param ?project=<owner/repo> required');

  const service = serviceClient();
  const project = await resolveProject(service, slug);
  if (!project) throw new HttpError(404, `project not found: ${slug}`);
  await requireProjectAdmin(service, project.id, callerUserId);

  const { data, error } = await service
    .from('api_tokens')
    .select('id, token_prefix, name, allowed_tools, allowed_scopes, created_by, created_at, last_used_at, expires_at, revoked_at')
    .eq('project_id', project.id)
    .order('created_at', { ascending: false });
  if (error) throw new HttpError(500, `token list failed: ${error.message}`);

  return c.json({ project_slug: project.repo_slug, tokens: data ?? [] });
});

// POST /token/:id/revoke — soft-revoke (admin of the token's project).
app.post('/token/:id/revoke', async (c) => {
  const callerUserId = requireUser(c.req.header('authorization') ?? null);

  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw new HttpError(400, 'token id must be a UUID');

  const service = serviceClient();
  const { data: tok, error: lookupErr } = await service
    .from('api_tokens')
    .select('id, project_id, revoked_at')
    .eq('id', id)
    .maybeSingle();
  if (lookupErr) throw new HttpError(500, `token lookup failed: ${lookupErr.message}`);
  if (!tok) throw new HttpError(404, 'token not found');

  await requireProjectAdmin(service, (tok as { project_id: string }).project_id, callerUserId);

  if ((tok as { revoked_at: string | null }).revoked_at) {
    return c.json({ id, revoked_at: (tok as { revoked_at: string }).revoked_at, note: 'already revoked' });
  }

  const revokedAt = new Date().toISOString();
  const { error } = await service.from('api_tokens').update({ revoked_at: revokedAt }).eq('id', id);
  if (error) throw new HttpError(500, `revoke failed: ${error.message}`);

  return c.json({ id, revoked_at: revokedAt });
});

// POST /token/exchange — opaque token (X-TeamBrain-Token) -> minted access JWT.
// No user JWT required; the opaque token is the credential.
app.post('/token/exchange', async (c) => {
  const opaque = (c.req.header('x-teambrain-token') ?? '').trim();
  if (!opaque) throw new HttpError(401, 'X-TeamBrain-Token header required');

  const service   = serviceClient();
  const tokenHash = await sha256Hex(opaque);

  const { data: tok, error } = await service
    .from('api_tokens')
    .select('id, principal_user_id, project_id, allowed_tools, allowed_scopes, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new HttpError(500, `token lookup failed: ${error.message}`);
  if (!tok) throw new HttpError(401, 'invalid token');

  const t = tok as TokenRow & { expires_at: string; revoked_at: string | null };
  if (t.revoked_at) throw new HttpError(401, 'token revoked');
  if (new Date(t.expires_at).getTime() <= Date.now()) throw new HttpError(401, 'token expired');

  // Best-effort usage stamp; do not fail the exchange if it errors.
  await service.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', t.id);

  const accessToken = await mintAccessToken(t);

  const { data: proj } = await service
    .from('projects')
    .select('repo_slug')
    .eq('id', t.project_id)
    .maybeSingle();

  return c.json({
    access_token:   accessToken,
    token_type:     'Bearer',
    expires_in:     ACCESS_TOKEN_TTL_SECONDS,
    project_id:     t.project_id,
    project_slug:   (proj as { repo_slug: string } | null)?.repo_slug ?? null,
    allowed_tools:  t.allowed_tools,
    allowed_scopes: t.allowed_scopes,
  });
});

app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
