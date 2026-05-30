// teambrain-summarize/index.ts — Phase 5 § C1.
//
// POST /teambrain-summarize/propose — turn a merged PR's metadata into 0–3
// candidate TeamBrain captures (decision / convention / gotcha / context).
// Writes NOTHING: it only proposes. The capture-on-merge GitHub Action renders
// the proposals into the run summary, a human approves them via a GitHub
// Environment gate, and only THEN does the Action write the approved set
// through teambrain-rest under the project bot's short-lived JWT. See
// docs/phase-5-checklist.md § C.
//
// Auth: any valid `authenticated` JWT. The dispatcher (functions/main) verifies
// the signature when VERIFY_JWT=true and forwards the Authorization header; we
// decode-only, the same trust model as teambrain-rest / teambrain-mcp. In
// practice the caller is the project bot's exchanged-token JWT. Requiring a JWT
// stops anonymous callers from burning the AI key; no capability claim is
// needed because this endpoint touches no `thoughts` and enforces no RLS — the
// downstream capture call does.

import { Hono }                       from 'npm:hono@^4.6.0';
import type { ContentfulStatusCode }  from 'npm:hono@^4.6.0/utils/http-status';

import { proposeCaptures, SummarizeError, PrInput } from './summarize.ts';

// Reject an obviously-oversized request before doing any work (C1 done-when:
// an oversized body returns a structured 4xx, not a 500). buildUserPrompt
// truncates what is actually sent to the model; this only guards the ingress.
const MAX_INPUT_CHARS = 200_000;

if (!Deno.env.get('ANTHROPIC_API_KEY')) {
  console.error('teambrain-summarize: ANTHROPIC_API_KEY is not set — /propose will fail until it is configured');
}

class HttpError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) { super(message); }
}

// Decode-only JWT check (dispatcher already verified the signature). Mirrors
// teambrain-token's requireUser: an `authenticated` role is required.
function requireAuthenticated(authHeader: string | null): void {
  if (!authHeader) throw new HttpError(401, 'Authorization header required');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'JWT not in three-segment form');
  let payload: Record<string, unknown>;
  try {
    const padded = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
    payload = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    throw new HttpError(401, 'JWT payload is not valid base64url JSON');
  }
  if (payload.role !== 'authenticated') {
    throw new HttpError(403, `role=${String(payload.role)} not permitted; an authenticated token is required`);
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const app = new Hono().basePath('/teambrain-summarize');

// Centralized error mapping — handlers just throw. Provider failures are mapped
// so an Anthropic 401/429 never masquerades as the caller's own auth error:
// config problems are ours (500); anything else from the provider is a 502.
app.onError((err, c) => {
  if (err instanceof HttpError)      return c.json({ error: err.message }, err.status);
  if (err instanceof SummarizeError) return c.json({ error: err.message, kind: err.kind }, err.kind === 'config' ? 500 : 502);
  console.error('teambrain-summarize unhandled error:', err);
  return c.json({ error: 'internal error' }, 500);
});

interface ProposeBody {
  project_slug?:  unknown;
  title?:         unknown;
  body?:          unknown;
  commits?:       unknown;
  changed_paths?: unknown;
}

app.post('/propose', async (c) => {
  requireAuthenticated(c.req.header('authorization') ?? null);

  let raw: ProposeBody;
  try { raw = await c.req.json() as ProposeBody; }
  catch { throw new HttpError(400, 'request body must be JSON'); }

  const project_slug = typeof raw.project_slug === 'string' ? raw.project_slug.trim() : '';
  const title        = typeof raw.title === 'string' ? raw.title : '';
  if (!project_slug) throw new HttpError(400, 'project_slug required (format "owner/repo")');
  if (!title.trim()) throw new HttpError(400, 'title required');

  const input: PrInput = {
    project_slug,
    title,
    body:          typeof raw.body === 'string' ? raw.body : '',
    commits:       asStringArray(raw.commits),
    changed_paths: asStringArray(raw.changed_paths),
  };

  const inputChars =
    input.title.length +
    input.body.length +
    input.commits.reduce((n, s) => n + s.length, 0) +
    input.changed_paths.reduce((n, s) => n + s.length, 0);
  if (inputChars > MAX_INPUT_CHARS) {
    throw new HttpError(413, `PR metadata too large (${inputChars} chars > ${MAX_INPUT_CHARS} limit)`);
  }

  const proposals = await proposeCaptures(input);
  return c.json({ project_slug, count: proposals.length, proposals });
});

app.all('*', (c) => c.json({ error: `no route: ${c.req.method} ${c.req.path}` }, 404));

Deno.serve(app.fetch);
