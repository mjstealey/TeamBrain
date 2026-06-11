// teambrain-slack/index.ts — Phase 5 § B: Slack capture/recall surface.
//
// A `/tb` slash command (remember / recall / recent / status / link / help)
// over the existing TeamBrain backend. The channel the command is typed in
// resolves the project through `public.slack_channels` (migration 0023) —
// channel → project_id, the § B requirement.
//
// Deliberate divergence from OB1's slack-capture (the pattern this adapts —
// see CREDITS.md): OB1 captures EVERY message in a dedicated single-user
// inbox channel and writes via service_role. For a team channel that
// over-captures (the § C capture-discipline lesson), and service_role would
// bypass RLS (the § A constraint). Here capture is explicit (`/tb remember`),
// and every write/read runs under a short-lived per-project BOT JWT through
// the existing REST surface — same RLS, same 0012 capability fence.
//
// Auth model, per surface:
//   * `POST /slack/command` — authenticated by the Slack request signature
//     (HMAC over SLACK_SIGNING_SECRET; slack.ts). The dispatcher's global
//     VERIFY_JWT gate is satisfied by nginx injecting the PUBLIC anon key as
//     the Authorization bearer on this path only (Slack cannot send custom
//     headers) — the same "public JWT satisfies the gateway, the real
//     credential rides elsewhere" shape as the § A /token/exchange route.
//   * `POST/GET/DELETE /links*` — project-admin gated on a GitHub-OAuth
//     *user* JWT, exactly like teambrain-token's CRUD routes. These arrive
//     through the generic nginx location, so the dispatcher verifies the JWT.
//
// Write path: mint a 5-minute HS256 bot JWT (same claim shape as the § A
// exchange — `teambrain_token: true`, tools capture/search/list, scopes
// ["project"]) and call teambrain-rest over the in-stack SUPABASE_URL
// (http://kong:8000). No opaque token is stored for Slack: the slack_channels
// row is the durable authorization, the signature is the authn, and deleting
// the row revokes the path within the JWT TTL. The 0012 FENCE INVariant
// holds — the bot still has no interactive login; this is a second
// *server-side* minting site with strictly narrower capabilities.
//
// Slack's 3-second ACK budget: command handlers ACK immediately and do the
// real work (embedding + REST round-trip) in the background via
// EdgeRuntime.waitUntil, delivering the result through response_url. If
// waitUntil is unavailable the work runs inline before the ACK (slower, but
// correct).

import { Hono }                          from 'npm:hono@^4.6.0';
import type { ContentfulStatusCode }     from 'npm:hono@^4.6.0/utils/http-status';
import { createClient, SupabaseClient }  from 'npm:@supabase/supabase-js@^2.45.0';
import { SignJWT }                       from 'npm:jose@^5.9.0';

import {
  mrkdwnEscape,
  parseSlashPayload,
  postToResponseUrl,
  relativeAge,
  SlackMessage,
  slackMessage,
  SlashPayload,
  splitSubcommand,
  truncate,
  verifySlackSignature,
} from './slack.ts';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL');               // in-stack: http://kong:8000
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const JWT_SECRET                = Deno.env.get('JWT_SECRET');
const SLACK_SIGNING_SECRET      = Deno.env.get('SLACK_SIGNING_SECRET');
// Public base for human-facing instructions (link recipes); NOT used for
// server-to-server calls, which stay on the in-stack SUPABASE_URL.
const PUBLIC_URL = (Deno.env.get('SUPABASE_PUBLIC_URL') ?? 'https://pr.fabric-testbed.net').replace(/\/$/, '');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('teambrain-slack: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY at boot');
}
if (!JWT_SECRET) {
  console.error('teambrain-slack: missing JWT_SECRET — cannot mint bot JWTs');
}
if (!SLACK_SIGNING_SECRET) {
  console.error('teambrain-slack: missing SLACK_SIGNING_SECRET — /slack/command is disabled (503) until it is set');
}

const BOT_JWT_TTL_SECONDS = 5 * 60; // covers one slash interaction
// Capabilities for Slack-minted bot JWTs. Narrower than § A token defaults:
// project scope only — a shared channel must never read/write `personal`.
const SLACK_ALLOWED_TOOLS  = ['capture_project_thought', 'search_project_thoughts', 'list_recent_project_thoughts'];
const SLACK_ALLOWED_SCOPES = ['project'];

const RECALL_LIMIT_DEFAULT  = 5;
const RECENT_LIMIT_DEFAULT  = 5;
const RECENT_LIMIT_MAX      = 15;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Slack IDs: workspace T…, channel C… (legacy private groups G…, DMs D…).
const SLACK_TEAM_RE    = /^T[A-Z0-9]{4,}$/;
const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]{4,}$/;

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });
}

// ---------------------------------------------------------------------------
// Errors + admin-route auth (same decode-only trust model as teambrain-token:
// the dispatcher verified the signature; we read the claims)
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
// Project + admin resolution (service_role; mirrors teambrain-token)
// ---------------------------------------------------------------------------

interface ProjectRow { id: string; repo_slug: string; name: string; bot_user_id: string | null; }

async function resolveProjectBySlug(service: SupabaseClient, slug: string): Promise<ProjectRow | null> {
  const { data, error } = await service
    .from('projects')
    .select('id, repo_slug, name, bot_user_id')
    .eq('repo_slug', slug)
    .maybeSingle();
  if (error) throw new HttpError(500, `project lookup failed: ${error.message}`);
  return (data as ProjectRow | null) ?? null;
}

async function resolveProjectById(service: SupabaseClient, id: string): Promise<ProjectRow | null> {
  const { data, error } = await service
    .from('projects')
    .select('id, repo_slug, name, bot_user_id')
    .eq('id', id)
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
    throw new HttpError(403, 'project admin role required to manage Slack channel links');
  }
}

// ---------------------------------------------------------------------------
// Per-project bot provisioning (lazy, idempotent — copied from teambrain-token
// § A2; the tiny-helper-duplication convention, same as jwtSub elsewhere)
// ---------------------------------------------------------------------------

async function findUserIdByEmail(service: SupabaseClient, email: string): Promise<string | null> {
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

  // No password, no identity, non-routable domain => no login path (the § A
  // fence invariant). Same bot the token exchange uses.
  const email = `bot+${project.id}@teambrain.local`;
  let botUserId: string | null;
  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { teambrain_bot: true, project_id: project.id, project_slug: project.repo_slug },
    app_metadata:  { teambrain_bot: true },
  });
  if (createErr) {
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
// Bot-JWT minting + REST client
// ---------------------------------------------------------------------------

interface LinkRow {
  id:                 string;
  slack_team_id:      string;
  slack_team_domain:  string | null;
  slack_channel_id:   string;
  slack_channel_name: string | null;
  project_id:         string;
  linked_by:          string | null;
  created_at:         string;
  last_used_at:       string | null;
}

async function lookupLink(service: SupabaseClient, teamId: string, channelId: string): Promise<LinkRow | null> {
  const { data, error } = await service
    .from('slack_channels')
    .select('id, slack_team_id, slack_team_domain, slack_channel_id, slack_channel_name, project_id, linked_by, created_at, last_used_at')
    .eq('slack_team_id', teamId)
    .eq('slack_channel_id', channelId)
    .maybeSingle();
  if (error) throw new HttpError(500, `channel-link lookup failed: ${error.message}`);
  return (data as LinkRow | null) ?? null;
}

// Same claim shape as teambrain-token's exchange, so the 0012 capability
// fence and the MCP/REST app-layer guard both engage. teambrain_token_id
// carries the slack_channels row id (provenance: which link minted this).
async function mintBotJwt(link: LinkRow, botUserId: string): Promise<string> {
  if (!JWT_SECRET) throw new HttpError(500, 'server misconfigured: JWT_SECRET not set');
  const secret = new TextEncoder().encode(JWT_SECRET);
  const now    = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    role:                     'authenticated',
    teambrain_token:          true,
    teambrain_token_id:       link.id,
    teambrain_project_id:     link.project_id,
    teambrain_allowed_tools:  SLACK_ALLOWED_TOOLS,
    teambrain_allowed_scopes: SLACK_ALLOWED_SCOPES,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(botUserId)
    .setAudience('authenticated')
    .setIssuedAt(now)
    .setExpirationTime(now + BOT_JWT_TTL_SECONDS)
    .sign(secret);
}

// Call teambrain-rest in-stack (through Kong; the dispatcher verifies the
// minted HS256 JWT against the same JWT_SECRET). Returns parsed JSON or
// throws with the REST surface's `{error}` message.
async function restCall(
  jwt:    string,
  method: 'GET' | 'POST',
  path:   string,
  body?:  unknown,
): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/teambrain-rest${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${jwt}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) {
    throw new HttpError(502, `teambrain-rest ${method} ${path} → ${res.status}: ${json?.error ?? 'unparseable error body'}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Background scheduling (Slack's 3s ACK budget)
// ---------------------------------------------------------------------------

interface EdgeRuntimeNS { waitUntil?: (p: Promise<unknown>) => void; }

// True if the work was handed to the runtime (respond now); false if the
// caller must await it inline before responding.
function scheduleBackground(work: Promise<void>): boolean {
  const er = (globalThis as { EdgeRuntime?: EdgeRuntimeNS }).EdgeRuntime;
  if (er && typeof er.waitUntil === 'function') {
    er.waitUntil(work);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Slash subcommand implementations (run in background; deliver via
// response_url)
// ---------------------------------------------------------------------------

interface CommandCtx {
  payload: SlashPayload;
  link:    LinkRow;
  slug:    string;   // the linked project's repo_slug
  jwt:     string;   // minted bot JWT
}

async function doRemember(ctx: CommandCtx, text: string): Promise<SlackMessage> {
  const captured = await restCall(ctx.jwt, 'POST', '/thoughts', {
    content:      text,
    scope:        'project',
    project_slug: ctx.slug,
    tags:         ['slack', `slack-user:${ctx.payload.userName}`, `slack-channel:${ctx.payload.channelName}`],
  }) as { id: string };

  // in_channel: the team seeing what was captured is the point of a shared
  // memory — and the echoed `/tb remember …` invocation shows who said it.
  return slackMessage(
    'in_channel',
    `:brain: Captured to *${mrkdwnEscape(ctx.slug)}*: “${mrkdwnEscape(truncate(text, 160))}”\n` +
    `_id ${captured.id} · scope project · by @${mrkdwnEscape(ctx.payload.userName)}_`,
  );
}

interface SearchResult {
  id: string; content: string; scope: string; type: string | null;
  confidence: string | null; stale_flagged_at: string | null;
  similarity: number; rank_score: number | null; created_at: string;
}

async function doRecall(ctx: CommandCtx, query: string): Promise<SlackMessage> {
  const out = await restCall(ctx.jwt, 'POST', '/thoughts/search', {
    query,
    project_slug: ctx.slug,
    limit:        RECALL_LIMIT_DEFAULT,
  }) as { count: number; results: SearchResult[] };

  if (out.count === 0) {
    return slackMessage('ephemeral', `No memories in *${mrkdwnEscape(ctx.slug)}* matched “${mrkdwnEscape(truncate(query, 80))}”.`);
  }

  const lines = out.results.map((r) => {
    const flags =
      (r.confidence === 'deprecated' ? ' :no_entry_sign: deprecated' : '') +
      (r.stale_flagged_at            ? ' :hourglass: stale-flagged'  : '');
    const score = r.rank_score ?? r.similarity;
    return `• *[${r.type ?? 'thought'}]* ${mrkdwnEscape(truncate(r.content, 180))}\n` +
           `   _${score.toFixed(2)} · ${relativeAge(r.created_at)} · ${r.id.slice(0, 8)}${flags}_`;
  });
  return slackMessage(
    'ephemeral',
    `*${out.count}* match${out.count === 1 ? '' : 'es'} in *${mrkdwnEscape(ctx.slug)}* for “${mrkdwnEscape(truncate(query, 80))}”:\n${lines.join('\n')}`,
  );
}

interface ListResult {
  id: string; content: string; type: string | null;
  confidence: string | null; stale_flagged_at: string | null; created_at: string;
}

async function doRecent(ctx: CommandCtx, rest: string): Promise<SlackMessage> {
  const n = Math.min(Math.max(parseInt(rest, 10) || RECENT_LIMIT_DEFAULT, 1), RECENT_LIMIT_MAX);
  const out = await restCall(
    ctx.jwt, 'GET',
    `/thoughts?project_slug=${encodeURIComponent(ctx.slug)}&limit=${n}`,
  ) as { count: number; results: ListResult[] };

  if (out.count === 0) {
    return slackMessage('ephemeral', `No memories yet in *${mrkdwnEscape(ctx.slug)}*. Capture one with \`/tb remember <text>\`.`);
  }

  const lines = out.results.map((r) => {
    const flags =
      (r.confidence === 'deprecated' ? ' :no_entry_sign:' : '') +
      (r.stale_flagged_at            ? ' :hourglass:'      : '');
    return `• *[${r.type ?? 'thought'}]* ${mrkdwnEscape(truncate(r.content, 180))} _(${relativeAge(r.created_at)})_${flags}`;
  });
  return slackMessage(
    'ephemeral',
    `Last *${out.count}* memories in *${mrkdwnEscape(ctx.slug)}*:\n${lines.join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// Synchronous subcommands (no REST round-trip; answer inside the ACK)
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  '*TeamBrain* — shared memory for this channel’s project.',
  '`/tb remember <text>` — capture a memory (project scope, visible to the team)',
  '`/tb recall <query>` — semantic search, top matches (only you see the reply)',
  '`/tb recent [n]` — last n memories (default 5, max 15; only you see the reply)',
  '`/tb status` — which project this channel is linked to',
  '`/tb link <owner/repo>` — how to link this channel (project admins)',
].join('\n');

function statusMessage(link: LinkRow | null, slug: string | null): SlackMessage {
  if (!link || !slug) {
    return slackMessage(
      'ephemeral',
      'This channel is not linked to a TeamBrain project yet. A project admin can link it — run `/tb link <owner/repo>` for the recipe.',
    );
  }
  return slackMessage(
    'ephemeral',
    `This channel is linked to *${mrkdwnEscape(slug)}* (since ${link.created_at.slice(0, 10)}` +
    `${link.last_used_at ? `, last used ${relativeAge(link.last_used_at)}` : ''}).`,
  );
}

function linkRecipeMessage(p: SlashPayload, slugArg: string): SlackMessage {
  const slug = slugArg || '<owner/repo>';
  // Linking cannot be authorized from inside Slack: a Slack user does not map
  // to a GitHub identity. The admin proves project-admin rights by calling
  // the REST route with their GitHub-OAuth JWT (from the landing page).
  return slackMessage(
    'ephemeral',
    [
      `To link this channel to *${mrkdwnEscape(slug)}* you must be a TeamBrain admin of that project.`,
      `1. Sign in at ${PUBLIC_URL} and copy your JWT into \`$USER_JWT\`.`,
      '2. Run:',
      '```',
      `curl -sS -X POST ${PUBLIC_URL}/functions/v1/teambrain-slack/links \\`,
      '  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \\',
      `  -d '{"project_slug": "${slug}", "slack_team_id": "${p.teamId}", "slack_channel_id": "${p.channelId}",`,
      `       "slack_channel_name": "${p.channelName}", "slack_team_domain": "${p.teamDomain}"}'`,
      '```',
      'Then `/tb status` here to confirm.',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono().basePath('/teambrain-slack');

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error('teambrain-slack unhandled error:', err);
  return c.json({ error: 'internal error' }, 500);
});

// --- GET /health -------------------------------------------------------------
app.get('/health', (c) => {
  return c.json({
    service:                'teambrain-slack',
    version:                '0.1.0',
    slack_command_enabled:  Boolean(SLACK_SIGNING_SECRET),
    checked_at:             new Date().toISOString(),
  });
});

// --- POST /slack/command — the slash-command receiver ------------------------
// Auth = Slack request signature. The Authorization header on this path is
// the nginx-injected public anon key (gateway formality) and is ignored here.
app.post('/slack/command', async (c) => {
  if (!SLACK_SIGNING_SECRET) {
    throw new HttpError(503, 'Slack integration not configured (SLACK_SIGNING_SECRET unset)');
  }

  const rawBody = await c.req.text();
  const ok = await verifySlackSignature(
    SLACK_SIGNING_SECRET,
    rawBody,
    c.req.header('x-slack-request-timestamp'),
    c.req.header('x-slack-signature'),
  );
  if (!ok) throw new HttpError(401, 'Slack signature verification failed');

  const p = parseSlashPayload(rawBody);
  const { sub, rest } = splitSubcommand(p.text);

  // Pure subcommands: answer inside the ACK, no DB/REST work.
  if (sub === '' || sub === 'help') return c.json(slackMessage('ephemeral', HELP_TEXT));
  if (sub === 'link')               return c.json(linkRecipeMessage(p, rest.split(/\s+/)[0] ?? ''));

  const service = serviceClient();
  const link    = await lookupLink(service, p.teamId, p.channelId);

  if (sub === 'status') {
    let slug: string | null = null;
    if (link) slug = (await resolveProjectById(service, link.project_id))?.repo_slug ?? null;
    return c.json(statusMessage(link, slug));
  }

  if (!['remember', 'recall', 'recent'].includes(sub)) {
    return c.json(slackMessage('ephemeral', `Unknown subcommand \`${mrkdwnEscape(sub)}\`.\n${HELP_TEXT}`));
  }

  if (!link) return c.json(statusMessage(null, null));

  if ((sub === 'remember' || sub === 'recall') && rest === '') {
    return c.json(slackMessage('ephemeral', `\`/tb ${sub}\` needs text — e.g. \`/tb ${sub === 'remember' ? 'remember We pin postgres at 17.6' : 'recall embedding provider decision'}\`.`));
  }

  const project = await resolveProjectById(service, link.project_id);
  if (!project) throw new HttpError(500, 'channel link points at a missing project (was it deleted?)');

  const botUserId = await ensureBotUser(service, project);
  const jwt       = await mintBotJwt(link, botUserId);
  const ctx: CommandCtx = { payload: p, link, slug: project.repo_slug, jwt };

  // Best-effort ops stamp; never blocks the command.
  service.from('slack_channels').update({ last_used_at: new Date().toISOString() }).eq('id', link.id)
    .then(({ error }) => { if (error) console.error('teambrain-slack: last_used_at stamp failed:', error.message); });

  const work = (async () => {
    let message: SlackMessage;
    try {
      if      (sub === 'remember') message = await doRemember(ctx, rest);
      else if (sub === 'recall')   message = await doRecall(ctx, rest);
      else                         message = await doRecent(ctx, rest);
    } catch (err) {
      console.error(`teambrain-slack: ${sub} failed:`, err);
      message = slackMessage('ephemeral', `:warning: \`/tb ${sub}\` failed: ${mrkdwnEscape((err as Error).message)}`);
    }
    await postToResponseUrl(p.responseUrl, message);
  })();

  if (scheduleBackground(work)) {
    // ACK within the 3s budget; the result follows via response_url.
    return c.json(slackMessage('ephemeral', sub === 'remember' ? ':brain: Capturing…' : ':mag: Searching…'));
  }
  // No waitUntil on this runtime: finish inline (response already delivered
  // through response_url), then ACK with an empty 200 so Slack adds nothing.
  await work;
  return c.body(null, 200);
});

// --- Admin link management (project-admin gated, GitHub-OAuth user JWT) ------

interface LinkBody {
  project_slug?:       unknown;
  slack_team_id?:      unknown;
  slack_channel_id?:   unknown;
  slack_team_domain?:  unknown;
  slack_channel_name?: unknown;
}

// POST /links — link a channel to a project.
app.post('/links', async (c) => {
  const callerUserId = requireUser(c.req.header('authorization') ?? null);

  let body: LinkBody;
  try { body = await c.req.json() as LinkBody; }
  catch { throw new HttpError(400, 'request body must be JSON'); }

  const slug      = typeof body.project_slug === 'string'     ? body.project_slug.trim()             : '';
  const teamId    = typeof body.slack_team_id === 'string'    ? body.slack_team_id.trim()            : '';
  const channelId = typeof body.slack_channel_id === 'string' ? body.slack_channel_id.trim()         : '';
  if (!slug)                            throw new HttpError(400, 'project_slug required (format "owner/repo")');
  if (!SLACK_TEAM_RE.test(teamId))      throw new HttpError(400, 'slack_team_id must be a Slack workspace id (T…)');
  if (!SLACK_CHANNEL_RE.test(channelId)) throw new HttpError(400, 'slack_channel_id must be a Slack channel id (C…)');

  const service = serviceClient();
  const project = await resolveProjectBySlug(service, slug);
  if (!project) throw new HttpError(404, `project not found: ${slug}`);
  await requireProjectAdmin(service, project.id, callerUserId);

  const existing = await lookupLink(service, teamId, channelId);
  if (existing) {
    if (existing.project_id === project.id) {
      return c.json({ id: existing.id, project_slug: slug, slack_team_id: teamId, slack_channel_id: channelId, note: 'already linked' });
    }
    const other = await resolveProjectById(service, existing.project_id);
    throw new HttpError(409,
      `channel already linked to ${other?.repo_slug ?? existing.project_id}; ` +
      `unlink it first (DELETE /teambrain-slack/links/${existing.id}, requires admin of that project)`);
  }

  const { data, error } = await service
    .from('slack_channels')
    .insert({
      slack_team_id:      teamId,
      slack_team_domain:  typeof body.slack_team_domain  === 'string' ? body.slack_team_domain.trim()  || null : null,
      slack_channel_id:   channelId,
      slack_channel_name: typeof body.slack_channel_name === 'string' ? body.slack_channel_name.trim() || null : null,
      project_id:         project.id,
      linked_by:          callerUserId,
    })
    .select('id, slack_team_id, slack_channel_id, slack_channel_name, created_at')
    .single();
  if (error) throw new HttpError(500, `link insert failed: ${error.message}`);

  return c.json({ ...(data as Record<string, unknown>), project_slug: slug }, 201);
});

// GET /links?project=owner/repo — list a project's channel links.
app.get('/links', async (c) => {
  const callerUserId = requireUser(c.req.header('authorization') ?? null);

  const slug = (c.req.query('project') ?? '').trim();
  if (!slug) throw new HttpError(400, 'query param ?project=<owner/repo> required');

  const service = serviceClient();
  const project = await resolveProjectBySlug(service, slug);
  if (!project) throw new HttpError(404, `project not found: ${slug}`);
  await requireProjectAdmin(service, project.id, callerUserId);

  const { data, error } = await service
    .from('slack_channels')
    .select('id, slack_team_id, slack_team_domain, slack_channel_id, slack_channel_name, linked_by, created_at, last_used_at')
    .eq('project_id', project.id)
    .order('created_at', { ascending: false });
  if (error) throw new HttpError(500, `link list failed: ${error.message}`);

  return c.json({ project_slug: slug, links: data ?? [] });
});

// DELETE /links/:id — unlink (admin of the link's project). Hard delete:
// the row is configuration, not provenance; thought rows it produced keep
// their own tags/author trail.
app.delete('/links/:id', async (c) => {
  const callerUserId = requireUser(c.req.header('authorization') ?? null);

  const id = c.req.param('id');
  if (!UUID_RE.test(id)) throw new HttpError(400, 'link id must be a UUID');

  const service = serviceClient();
  const { data: row, error: lookupErr } = await service
    .from('slack_channels')
    .select('id, project_id')
    .eq('id', id)
    .maybeSingle();
  if (lookupErr) throw new HttpError(500, `link lookup failed: ${lookupErr.message}`);
  if (!row) throw new HttpError(404, 'link not found');

  await requireProjectAdmin(service, (row as { project_id: string }).project_id, callerUserId);

  const { error } = await service.from('slack_channels').delete().eq('id', id);
  if (error) throw new HttpError(500, `unlink failed: ${error.message}`);

  return c.json({ id, deleted: true });
});

app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
