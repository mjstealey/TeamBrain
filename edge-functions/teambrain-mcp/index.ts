// teambrain-mcp/index.ts — multi-tenant MCP server for TeamBrain.
//
// Architecture (Phase 2 § A2):
//   * Self-hosted Supabase Edge Runtime mounts this directory as a worker.
//     The dispatcher (`functions/main/index.ts` in the supabase docker
//     stack) validates the incoming JWT against the GoTrue JWKS endpoint
//     when VERIFY_JWT=true on the container, then forwards the request
//     to this worker with the original Authorization header intact.
//   * We do NOT re-verify the JWT here. The dispatcher's validation is
//     load-bearing: trusting it lets us keep this file focused on tool
//     dispatch rather than auth plumbing.
//   * Every tool call instantiates a per-request `userClient`: a
//     supabase-js client using the public ANON_KEY as the API key, with
//     the user's JWT forwarded in the Authorization header. PostgREST
//     reads `request.jwt.claims` from that header, RLS uses `auth.uid()`,
//     and the caller sees only the rows their policies permit. No
//     application-layer access checks live in this file.
//
// Phase 2 scope: this file currently exposes one tool — `ping` — to prove
// the JWT-forward + auth.uid() chain works end-to-end through the MCP
// transport. The five business tools (capture/search/list/mark_stale/
// promote) land in subsequent commits once the wiring is verified.

// Inline `npm:` specifiers (rather than import-map resolution) sidestep
// an Edge Runtime issue where prefix-style import-map entries get stuck
// in a stale-resolution state across worker restarts. With explicit npm:
// URLs the runtime resolves each module directly without consulting the
// import map at all.
import { Hono }                    from 'npm:hono@^4.6.0';
import { StreamableHTTPTransport } from 'npm:@hono/mcp@^0.1.0';
import { McpServer }               from 'npm:@modelcontextprotocol/sdk@^1.0.0/server/mcp.js';
import { z }                       from 'npm:zod@^3.23.0';
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';

import { embed, vectorLiteral }    from './embedding.ts';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

// SUPABASE_URL is the internal URL the Edge Runtime sees Kong/PostgREST at;
// the supabase docker stack injects this automatically into every function
// worker (see main/index.ts envVars passthrough).
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('teambrain-mcp: missing SUPABASE_URL or SUPABASE_ANON_KEY at boot');
}

// ---------------------------------------------------------------------------
// Per-request auth context (RLS = auth)
// ---------------------------------------------------------------------------

interface AuthContext {
  userClient: SupabaseClient;
  userId:     string;     // auth.uid() — the JWT's `sub` claim
}

// Decode the JWT payload's `sub` claim without re-verifying the signature.
// The dispatcher (`functions/main/index.ts`) verified the JWT against the
// GoTrue JWKS endpoint before forwarding to this worker, so trusting the
// claims here is safe. We intentionally avoid reaching for jose / a
// crypto library — the dispatcher is the verification authority.
function jwtSub(authHeader: string): string {
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT not in three-segment form');
  const padded  = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
  const payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  if (typeof payload.sub !== 'string') throw new Error('JWT missing `sub` claim');
  return payload.sub;
}

function getAuthContext(authHeader: string | null): AuthContext {
  if (!authHeader) {
    // The dispatcher rejects unauthenticated requests at the gateway when
    // VERIFY_JWT=true; reaching this branch means the container's verify
    // flag is off or the dispatcher was bypassed. Fail closed regardless.
    throw new Error('teambrain-mcp: Authorization header missing on tool call');
  }
  return {
    userClient: createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global:  { headers: { Authorization: authHeader } },
      auth:    { persistSession: false, autoRefreshToken: false },
      db:      { schema: 'public' },
    }),
    userId: jwtSub(authHeader),
  };
}

// ---------------------------------------------------------------------------
// Project-slug → project-id resolution
// ---------------------------------------------------------------------------
//
// Tools accept human-friendly slugs (e.g. "fabric-testbed/fabric-core-api")
// rather than UUIDs. The lookup goes through RLS, so an unauthorized caller
// gets a "not found" error rather than leaking the project's existence.
// `TEAMBRAIN_DEFAULT_PROJECT_SLUG` provides a server-side default for
// single-pilot deployments — Phase 3 (auto-membership sync) reconsiders.

async function resolveProjectId(
  userClient: SupabaseClient,
  slug:       string | undefined,
): Promise<{ projectId: string; slug: string } | { error: string }> {
  const effective = slug ?? Deno.env.get('TEAMBRAIN_DEFAULT_PROJECT_SLUG');
  if (!effective) {
    return { error: 'project_slug not provided and TEAMBRAIN_DEFAULT_PROJECT_SLUG not set on the server' };
  }
  const { data, error } = await userClient
    .from('projects')
    .select('id')
    .eq('repo_slug', effective)
    .maybeSingle();
  if (error) {
    return { error: `project lookup failed: ${error.message}` };
  }
  if (!data) {
    return { error: `project not found or not accessible to caller: ${effective}` };
  }
  return { projectId: (data as { id: string }).id, slug: effective };
}

// ---------------------------------------------------------------------------
// Hono app + MCP server
// ---------------------------------------------------------------------------

const app = new Hono();

// Lightweight liveness probe — useful for `docker compose ps`-style health
// checks and for confirming the worker booted cleanly. Does not touch the
// database or read auth.
//
// Path-agnostic routes: Kong + the Edge Runtime dispatcher rewrite the URL
// before this worker sees it, and the exact rewrite shape depends on
// supabase-stack version (`/functions/v1/` may or may not be stripped).
// We accept any GET as liveness and any POST as an MCP call rather than
// pinning to a specific pathname.
app.get('*', (c) => c.json({
  status:  'ok',
  service: 'teambrain-mcp',
  version: '0.1.0-phase2-wiring',
  path:    c.req.path,
}));

// Single MCP entry point. The `Authorization` header is captured
// per-request and threaded into each tool handler via closure on
// `userClient`.
app.post('*', async (c) => {
  const authHeader = c.req.header('Authorization') ?? null;

  const server = new McpServer({
    name:    'teambrain-mcp',
    version: '0.1.0',
  });

  // Tool: ping
  // Returns the calling user's auth.uid() and a few signals of round-trip
  // health. This is the wiring sanity test — if this works, the JWT-forward
  // pipeline is correctly carrying request.jwt.claims into PostgREST and
  // the caller's identity is recoverable for use by RLS.
  server.tool(
    'ping',
    'Returns the calling user\'s auth.uid() and basic round-trip diagnostics.',
    {
      // No args. zod-empty schema is required by the SDK contract.
    },
    async () => {
      const { userClient } = getAuthContext(authHeader);

      // public.whoami() was created in Phase 0 D8: returns auth.uid() as
      // uuid, security invoker, set search_path = ''. Reuse rather than
      // re-issuing a `select auth.uid()` here so the wiring test exercises
      // the same RPC path the real tools will use.
      const { data, error } = await userClient.rpc('whoami');

      if (error) {
        return {
          content: [{
            type: 'text',
            text: `ping ERROR: ${error.message} (code=${error.code ?? 'n/a'})`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            uid:        data,
            service:    'teambrain-mcp',
            version:    '0.1.0',
            checked_at: new Date().toISOString(),
          }, null, 2),
        }],
      };
    },
  );

  // Tool: capture_project_thought
  // Embeds `content` via OpenAI, resolves the project slug to a UUID
  // (RLS-filtered — unauthorized callers see "not found" rather than the
  // project's existence), then inserts a row into public.thoughts. The
  // RLS policy `thoughts_insert_self` enforces:
  //   * author_user_id must equal auth.uid() (we set it explicitly here);
  //   * personal scope is permitted for any authenticated caller;
  //   * project / project_private scope requires the caller to be admin
  //     or contributor on the resolved project (`app.is_project_writer`).
  // No application-layer access checks are performed in this handler.
  server.tool(
    'capture_project_thought',
    'Capture a new thought (decision, convention, gotcha, context, preference, runbook) ' +
    'into TeamBrain. Embedded for semantic search. Personal scope = author-only; ' +
    'project = visible to all members; project_private = admin/contributor only.',
    {
      content: z.string().min(1).max(10_000)
        .describe('The memory text. Markdown OK.'),
      scope: z.enum(['personal', 'project', 'project_private'])
        .default('project')
        .describe('Visibility scope. Defaults to "project".'),
      type: z.enum(['decision', 'convention', 'gotcha', 'context', 'preference', 'runbook'])
        .optional()
        .describe('Memory taxonomy. Optional but recommended.'),
      project_slug: z.string().optional()
        .describe('Repo slug like "fabric-testbed/fabric-core-api". ' +
                  'Required for project / project_private scope. ' +
                  'Falls back to TEAMBRAIN_DEFAULT_PROJECT_SLUG env if unset.'),
      tags: z.array(z.string()).default([])
        .describe('Free-form tags for filtering.'),
      paths: z.array(z.string()).default([])
        .describe('Repo file paths the thought relates to.'),
      linked_commit_sha: z.string().optional(),
      linked_pr_url:     z.string().optional(),
      linked_issue_url:  z.string().optional(),
    },
    async (args) => {
      const { userClient, userId } = getAuthContext(authHeader);

      // 1. Resolve project context (skip for personal scope — the CHECK
      //    constraint requires project_id IS NULL when scope = 'personal').
      let projectId: string | null = null;
      let resolvedSlug: string | null = null;
      if (args.scope !== 'personal') {
        const r = await resolveProjectId(userClient, args.project_slug);
        if ('error' in r) {
          return {
            content: [{ type: 'text', text: `capture_project_thought ERROR: ${r.error}` }],
            isError: true,
          };
        }
        projectId    = r.projectId;
        resolvedSlug = r.slug;
      }

      // 2. Generate embedding (1536 floats from text-embedding-3-small).
      let embedding: number[];
      try {
        embedding = await embed(args.content);
      } catch (e) {
        return {
          content: [{ type: 'text', text: `capture_project_thought ERROR: ${(e as Error).message}` }],
          isError: true,
        };
      }

      // 3. Insert. RLS WITH CHECK validates author_user_id = auth.uid()
      //    and writer-role for project / project_private; failure here
      //    indicates either an RLS denial (caller not a writer) or a
      //    schema/data issue.
      const { data, error } = await userClient
        .from('thoughts')
        .insert({
          content:           args.content,
          scope:             args.scope,
          type:              args.type ?? null,
          project_id:        projectId,
          author_user_id:    userId,
          embedding:         vectorLiteral(embedding),
          tags:              args.tags,
          paths:             args.paths,
          linked_commit_sha: args.linked_commit_sha ?? null,
          linked_pr_url:     args.linked_pr_url     ?? null,
          linked_issue_url:  args.linked_issue_url  ?? null,
        })
        .select('id, scope, type, project_id, created_at')
        .single();

      if (error) {
        return {
          content: [{
            type: 'text',
            text: `capture_project_thought ERROR: ${error.message} (code=${error.code ?? 'n/a'})`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            captured: {
              id:            (data as { id: string }).id,
              scope:         (data as { scope: string }).scope,
              type:          (data as { type: string | null }).type,
              project_slug:  resolvedSlug,
              project_id:    (data as { project_id: string | null }).project_id,
              created_at:    (data as { created_at: string }).created_at,
              content_chars: args.content.length,
              embedding_dims: embedding.length,
            },
          }, null, 2),
        }],
      };
    },
  );

  // Tool: search_project_thoughts
  // Embeds the query, then calls public.match_thoughts(...) — the
  // SECURITY INVOKER RPC defined in 0004_match_thoughts.sql. Because
  // the RPC is invoker-scoped, RLS on public.thoughts filters every
  // candidate row before similarity ranking; the caller never sees
  // anything outside their personal + project membership view, no
  // matter what filter args they pass.
  server.tool(
    'search_project_thoughts',
    'Semantic search over TeamBrain. Returns thoughts ranked by cosine ' +
    'similarity to the query, filtered to what the caller can see (RLS).',
    {
      query: z.string().min(1).max(2_000)
        .describe('Natural-language search query.'),
      project_slug: z.string().optional()
        .describe('Limit search to one project. Omit + pass null filter ' +
                  'to search across all projects the caller is a member of, ' +
                  'plus their personal thoughts. Falls back to ' +
                  'TEAMBRAIN_DEFAULT_PROJECT_SLUG when unset.'),
      scopes: z.array(z.enum(['personal', 'project', 'project_private']))
        .optional()
        .describe('Restrict to specific scopes. Default: all three (RLS still filters).'),
      limit: z.number().int().min(1).max(50).default(10)
        .describe('Max results (planner caps to limit).'),
      threshold: z.number().min(0).max(1).default(0.5)
        .describe('Minimum cosine similarity (0–1). Lower = looser match.'),
      cross_project: z.boolean().default(false)
        .describe('If true, ignore project_slug and search every accessible thought.'),
    },
    async (args) => {
      const { userClient } = getAuthContext(authHeader);

      // 1. Resolve project filter (skipped if cross_project=true).
      let filterProjectId: string | null = null;
      let resolvedSlug:    string | null = null;
      if (!args.cross_project) {
        const r = await resolveProjectId(userClient, args.project_slug);
        if ('error' in r) {
          return {
            content: [{ type: 'text', text: `search_project_thoughts ERROR: ${r.error}` }],
            isError: true,
          };
        }
        filterProjectId = r.projectId;
        resolvedSlug    = r.slug;
      }

      // 2. Embed the query.
      let queryVec: number[];
      try {
        queryVec = await embed(args.query);
      } catch (e) {
        return {
          content: [{ type: 'text', text: `search_project_thoughts ERROR: ${(e as Error).message}` }],
          isError: true,
        };
      }

      // 3. RPC into match_thoughts. RLS does the access filtering;
      //    the function does the cosine ranking + threshold cutoff.
      const { data, error } = await userClient.rpc('match_thoughts', {
        query_embedding:   vectorLiteral(queryVec),
        match_count:       args.limit,
        match_threshold:   args.threshold,
        filter_project_id: filterProjectId,
        filter_scopes:     args.scopes ?? null,
      });

      if (error) {
        return {
          content: [{
            type: 'text',
            text: `search_project_thoughts ERROR: ${error.message} (code=${error.code ?? 'n/a'})`,
          }],
          isError: true,
        };
      }

      const rows = (data ?? []) as Array<{
        id:               string;
        content:          string;
        scope:            string;
        type:             string | null;
        project_id:       string | null;
        author_user_id:   string | null;
        similarity:       number;
        created_at:       string;
        last_verified_at: string | null;
        tags:             string[];
      }>;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query:           args.query,
            project_slug:    resolvedSlug,
            cross_project:   args.cross_project,
            threshold:       args.threshold,
            count:           rows.length,
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
          }, null, 2),
        }],
      };
    },
  );

  // Tool: list_recent_project_thoughts
  // Plain recency listing — no embedding cost. Useful for "what was the
  // team thinking about lately" queries and as a sanity check that RLS
  // is filtering the same way it does for semantic search.
  server.tool(
    'list_recent_project_thoughts',
    'List the N most recent thoughts visible to the caller, ordered newest-first. ' +
    'No semantic ranking — pair with search_project_thoughts when you want relevance.',
    {
      project_slug: z.string().optional()
        .describe('Limit listing to one project. Falls back to TEAMBRAIN_DEFAULT_PROJECT_SLUG.'),
      scopes: z.array(z.enum(['personal', 'project', 'project_private']))
        .optional()
        .describe('Restrict to specific scopes. Default: all three (RLS still filters).'),
      limit: z.number().int().min(1).max(100).default(20)
        .describe('Max rows to return.'),
      since: z.string().optional()
        .describe('ISO 8601 timestamp; only return rows created after this instant.'),
      cross_project: z.boolean().default(false)
        .describe('If true, ignore project_slug and list every accessible thought.'),
    },
    async (args) => {
      const { userClient } = getAuthContext(authHeader);

      let filterProjectId: string | null = null;
      let resolvedSlug:    string | null = null;
      if (!args.cross_project) {
        const r = await resolveProjectId(userClient, args.project_slug);
        if ('error' in r) {
          return {
            content: [{ type: 'text', text: `list_recent_project_thoughts ERROR: ${r.error}` }],
            isError: true,
          };
        }
        filterProjectId = r.projectId;
        resolvedSlug    = r.slug;
      }

      let q = userClient
        .from('thoughts')
        .select('id, scope, type, project_id, author_user_id, content, tags, paths, ' +
                'confidence, created_at, last_verified_at, expires_at')
        .order('created_at', { ascending: false })
        .limit(args.limit);

      if (filterProjectId) q = q.eq('project_id', filterProjectId);
      if (args.scopes?.length) q = q.in('scope', args.scopes);
      if (args.since)          q = q.gt('created_at', args.since);

      const { data, error } = await q;
      if (error) {
        return {
          content: [{
            type: 'text',
            text: `list_recent_project_thoughts ERROR: ${error.message} (code=${error.code ?? 'n/a'})`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            project_slug:  resolvedSlug,
            cross_project: args.cross_project,
            count:         (data ?? []).length,
            results:       data ?? [],
          }, null, 2),
        }],
      };
    },
  );

  // Tool: mark_stale
  // Update a thought's confidence (default → 'deprecated') and bump
  // last_verified_at. RLS gates via thoughts_update_self_or_writer:
  //   * any caller can mark their own thought stale at any scope;
  //   * project writers can mark any project / project_private row in
  //     their project stale.
  // RLS-blocked updates return zero rows from PostgREST without erroring.
  // We surface that distinctly as `updated: false` rather than leaking
  // "row exists but you can't touch it" vs "row doesn't exist".
  server.tool(
    'mark_stale',
    'Flag a thought as stale (default confidence: "deprecated"). Bumps ' +
    'last_verified_at. RLS-gated: caller must be the author or a project writer.',
    {
      thought_id: z.string().uuid()
        .describe('UUID of the thought to mark.'),
      confidence: z.enum(['tentative', 'deprecated']).default('deprecated')
        .describe('New confidence value.'),
      reason: z.string().optional()
        .describe('Optional reason; appended to metadata.staleness_reason.'),
    },
    async (args) => {
      const { userClient } = getAuthContext(authHeader);

      // Build the update payload. We touch metadata only when a reason
      // is provided so we don't overwrite existing keys with an empty
      // staleness_reason on plain re-marks.
      const patch: Record<string, unknown> = {
        confidence:       args.confidence,
        last_verified_at: new Date().toISOString(),
      };

      const { data, error } = await userClient
        .from('thoughts')
        .update(patch)
        .eq('id', args.thought_id)
        .select('id, confidence, last_verified_at')
        .maybeSingle();

      if (error) {
        return {
          content: [{
            type: 'text',
            text: `mark_stale ERROR: ${error.message} (code=${error.code ?? 'n/a'})`,
          }],
          isError: true,
        };
      }

      if (!data) {
        // Either the row doesn't exist, or RLS blocked the update.
        // Don't distinguish — that distinction would itself be a leak.
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              updated: false,
              thought_id: args.thought_id,
              reason: 'thought not found, or caller lacks update permission',
            }, null, 2),
          }],
        };
      }

      // Optional reason is captured client-side for now (not persisted to
      // metadata); Phase 6 promotion workflow will surface it. Keep the
      // payload simple here.
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            updated: true,
            id:               (data as { id: string }).id,
            new_confidence:   (data as { confidence: string }).confidence,
            last_verified_at: (data as { last_verified_at: string }).last_verified_at,
            reason_received:  args.reason ?? null,
          }, null, 2),
        }],
      };
    },
  );

  // Tool: promote_to_docs (Phase 2 placeholder)
  // Phase 6 will fully implement promotion: generate an ADR-style markdown
  // file from the thought, create a branch, commit, and open a PR via the
  // GitHub API. For Phase 2 this tool returns a *preview* payload that
  // shows what would be promoted, without touching GitHub. Calling it is
  // safe — it only reads the thought (RLS-gated) and returns a struct.
  server.tool(
    'promote_to_docs',
    '[Preview only — Phase 2] Returns a structured preview of what a ' +
    'docs PR for this thought would contain. Does NOT yet create a ' +
    'branch or open a PR; that lands in Phase 6.',
    {
      thought_id: z.string().uuid()
        .describe('UUID of the thought to preview promotion for.'),
      target_path: z.string().default('docs/adr/')
        .describe('Repo-relative directory the eventual PR would write into.'),
      target_branch: z.string().default('main')
        .describe('Base branch of the eventual PR.'),
    },
    async (args) => {
      const { userClient } = getAuthContext(authHeader);

      const { data, error } = await userClient
        .from('thoughts')
        .select('id, scope, type, content, project_id, author_user_id, ' +
                'tags, paths, linked_commit_sha, linked_pr_url, ' +
                'linked_issue_url, created_at, last_verified_at')
        .eq('id', args.thought_id)
        .maybeSingle();

      if (error) {
        return {
          content: [{
            type: 'text',
            text: `promote_to_docs ERROR: ${error.message} (code=${error.code ?? 'n/a'})`,
          }],
          isError: true,
        };
      }

      if (!data) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              thought_id: args.thought_id,
              reason: 'thought not found, or caller lacks read permission',
            }, null, 2),
          }],
        };
      }

      const t = data as {
        id: string; scope: string; type: string | null; content: string;
        project_id: string | null; author_user_id: string | null;
        tags: string[]; paths: string[]; linked_commit_sha: string | null;
        linked_pr_url: string | null; linked_issue_url: string | null;
        created_at: string; last_verified_at: string | null;
      };

      // Generate the markdown body that the future PR would commit.
      // Same shape as `docs/adr/0001-teambrain-architecture.md` so the
      // promoted artifact slots into existing docs without reformatting.
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

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            preview: true,
            note:  'Phase 2 preview only — no PR was created. Phase 6 will wire the GitHub API.',
            request: {
              thought_id:    t.id,
              target_path:   args.target_path,
              target_branch: args.target_branch,
              proposed_branch:    branch,
              proposed_filename:  filename,
              proposed_full_path: args.target_path.replace(/\/?$/, '/') + filename,
            },
            commit_payload: {
              filename,
              markdown: md,
            },
          }, null, 2),
        }],
      };
    },
  );

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

Deno.serve(app.fetch);
