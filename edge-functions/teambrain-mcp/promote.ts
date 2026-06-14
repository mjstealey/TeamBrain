// promote.ts — Phase 6 § D: promote a TeamBrain thought into a real docs/ADR PR.
//
// Shared by teambrain-mcp (`promote_to_docs` tool) and teambrain-rest
// (`POST /thoughts/:id/promote`). Lives under teambrain-mcp/ alongside
// embedding.ts and is imported cross-function by teambrain-rest, mirroring the
// existing shared-module pattern (rest already imports embedding.ts from here;
// register-project imports github.ts from teambrain-membership-sync). All three
// functions co-deploy under the same Edge Runtime root, so the relative imports
// resolve at runtime.
//
// What it does, in order:
//   1. Read the thought through the caller's RLS-scoped client (so promotion
//      can only touch a thought the caller can already see).
//   2. Idempotency: if the thought already carries `promoted_pr_url`, return it
//      without opening a second PR.
//   3. Resolve the thought's project → `repo_slug` (owner/repo).
//   4. Authorize: the caller must be a project writer (contributor | admin) —
//      the same floor as capture. The PR write goes to GitHub, not the DB, so
//      RLS cannot gate it implicitly; we check `project_members` explicitly
//      (RLS lets a member read their own row).
//   5. Via the TeamBrain GitHub App installation token (reused from
//      teambrain-membership-sync/github.ts): create a branch off the base,
//      commit the generated ADR-style markdown, and open a PR.
//   6. Best-effort stamp the source thought (`promoted_pr_url` + confidence
//      'confirmed'). A stamp failure never fails an already-opened PR.
//
// The GitHub App needs **Contents: write** and **Pull requests: write** on the
// target repo for steps 5. Until that grant lands, those calls return 403/404;
// `PromoteError` translates them into an actionable message.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';
import { getInstallationToken } from '../teambrain-membership-sync/github.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromoteOptions {
  userClient:    SupabaseClient;
  userId:        string;          // caller's auth.uid()
  thoughtId:     string;
  targetPath?:   string;          // repo-relative dir; omit ⇒ type-aware default (see defaultTargetPath)
  targetBranch:  string;          // base branch, e.g. 'main'
}

// Business outcomes are returned (not thrown); infra/GitHub failures throw
// PromoteError so the handlers can map them to an MCP isError / HTTP 5xx.
export type PromoteResult =
  | { ok: false; code: 'not_found' | 'not_a_project_thought' | 'forbidden'; reason: string }
  | {
      ok: true;
      already_promoted: boolean;
      pr_url:    string;
      branch:    string;
      path:      string;
      repo_slug: string;
      stamped:   boolean;
      stamp_error?: string;
    };

export class PromoteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'PromoteError';
  }
}

interface ThoughtRow {
  id: string; scope: string; type: string | null; content: string;
  project_id: string | null; author_user_id: string | null;
  tags: string[] | null; paths: string[] | null;
  linked_commit_sha: string | null; linked_pr_url: string | null;
  linked_issue_url: string | null; created_at: string;
  last_verified_at: string | null; promoted_pr_url: string | null;
}

// ---------------------------------------------------------------------------
// Markdown generation (same shape as docs/adr/0001-teambrain-architecture.md
// so the promoted artifact slots into existing docs without reformatting).
// ---------------------------------------------------------------------------

export function buildMarkdown(t: ThoughtRow): string {
  const tags  = t.tags  ?? [];
  const paths = t.paths ?? [];
  return [
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
    paths.length > 0    ? `- paths: ${paths.map((p) => '`' + p + '`').join(', ')}` : null,
    tags.length  > 0    ? `- tags: ${tags.map((p)  => '`' + p + '`').join(', ')}`  : null,
  ].filter((x) => x !== null).join('\n') + '\n';   // trailing newline (POSIX / markdownlint MD047)
}

// Type-aware default docs location when the caller doesn't pass target_path.
// Only `decision` thoughts become ADRs; other types land in their own docs
// area rather than being mislabeled under docs/adr/. An explicit target_path
// always overrides this. The thought's `type` is in the filename either way.
function defaultTargetPath(type: string | null): string {
  switch (type) {
    case 'decision': return 'docs/adr/';
    case 'runbook':  return 'docs/runbooks/';
    case 'context':  return 'docs/context/';
    default:         return 'docs/notes/';   // convention | gotcha | preference | untyped
  }
}

// UTF-8-safe base64 for the GitHub Contents API. Thoughts are small, so the
// classic encodeURIComponent → btoa trick is sufficient and avoids spreading a
// large byte array (which can overflow the call stack on big inputs).
function toBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

// ---------------------------------------------------------------------------
// GitHub REST helpers (installation-token auth)
// ---------------------------------------------------------------------------

const GH_API = 'https://api.github.com';

async function gh(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
  return { status: resp.status, json };
}

// Map a non-2xx GitHub response to an actionable PromoteError. A 403/404 on the
// write calls almost always means the App lacks Contents/PR-write or isn't
// installed on the repo — say so rather than echoing a bare status.
function ghFail(stage: string, repo: string, status: number, json: any): never {
  const ghMsg = json?.message ?? json?.raw ?? '(no body)';
  if (status === 403 || status === 404) {
    throw new PromoteError(
      502,
      `GitHub ${stage} failed (${status}) on ${repo}: ${ghMsg}. The TeamBrain ` +
      `GitHub App likely needs "Contents: write" + "Pull requests: write" on ` +
      `this repo (and must be installed on it). See scripts/smoke-promote-to-docs.md.`,
    );
  }
  throw new PromoteError(502, `GitHub ${stage} failed (${status}) on ${repo}: ${ghMsg}`);
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export async function promoteThoughtToDocs(opts: PromoteOptions): Promise<PromoteResult> {
  const { userClient, userId, thoughtId, targetPath, targetBranch } = opts;

  // 1. Read the thought (RLS-scoped).
  const { data, error } = await userClient
    .from('thoughts')
    .select('id, scope, type, content, project_id, author_user_id, tags, paths, ' +
            'linked_commit_sha, linked_pr_url, linked_issue_url, created_at, ' +
            'last_verified_at, promoted_pr_url')
    .eq('id', thoughtId)
    .maybeSingle();

  if (error) {
    throw new PromoteError(502, `thought lookup failed: ${error.message} (code=${error.code ?? 'n/a'})`);
  }
  if (!data) {
    return { ok: false, code: 'not_found', reason: 'thought not found, or caller lacks read permission' };
  }
  const t = data as unknown as ThoughtRow;

  // A thought must belong to a project to be promoted (a docs PR needs a repo).
  if (!t.project_id) {
    return {
      ok: false, code: 'not_a_project_thought',
      reason: 'thought has no project_id (personal scope); promotion targets a project repo',
    };
  }

  // 3. Resolve project → repo_slug (RLS: members can read their projects).
  const { data: proj, error: projErr } = await userClient
    .from('projects')
    .select('repo_slug')
    .eq('id', t.project_id)
    .maybeSingle();
  if (projErr) {
    throw new PromoteError(502, `project lookup failed: ${projErr.message} (code=${projErr.code ?? 'n/a'})`);
  }
  if (!proj || !(proj as { repo_slug: string }).repo_slug) {
    return { ok: false, code: 'not_found', reason: 'project for this thought not found or not accessible' };
  }
  const repoSlug = (proj as { repo_slug: string }).repo_slug;

  // 4. Authorize: caller must be a writer (contributor | admin) on the project.
  //    Mirrors app.is_project_writer, checked explicitly because the write
  //    target is GitHub (RLS can't gate it). RLS lets a member see only their
  //    own project_members row, so filtering by self is exact.
  const { data: member, error: memErr } = await userClient
    .from('project_members')
    .select('role')
    .eq('project_id', t.project_id)
    .eq('user_id', userId)
    .is('removed_at', null)
    .maybeSingle();
  if (memErr) {
    throw new PromoteError(502, `membership lookup failed: ${memErr.message} (code=${memErr.code ?? 'n/a'})`);
  }
  const role = (member as { role?: string } | null)?.role;
  if (role !== 'contributor' && role !== 'admin') {
    return {
      ok: false, code: 'forbidden',
      reason: `promotion requires contributor or admin on ${repoSlug} (your role: ${role ?? 'none'})`,
    };
  }

  // Conventions (match the former preview stub so existing expectations hold).
  const id8      = t.id.slice(0, 8);
  const filename = `${id8}-${t.type ?? 'thought'}.md`;
  const branch   = `teambrain/promote-${id8}`;
  const path     = (targetPath ?? defaultTargetPath(t.type)).replace(/^\/+/, '').replace(/\/?$/, '/') + filename;

  // 2. Idempotency: already promoted → return the recorded PR, do not re-open.
  if (t.promoted_pr_url) {
    return {
      ok: true, already_promoted: true,
      pr_url: t.promoted_pr_url, branch, path, repo_slug: repoSlug, stamped: false,
    };
  }

  // 5. GitHub: branch → file → PR.
  const [owner, repo] = repoSlug.split('/');
  if (!owner || !repo) {
    throw new PromoteError(500, `project repo_slug is not "owner/repo": ${repoSlug}`);
  }
  const token = await getInstallationToken();
  const md = buildMarkdown(t);

  // 5a. Base branch SHA.
  const baseRef = await gh(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
  if (baseRef.status !== 200) ghFail(`base-branch lookup (${targetBranch})`, repoSlug, baseRef.status, baseRef.json);
  const baseSha = baseRef.json?.object?.sha as string | undefined;
  if (!baseSha) throw new PromoteError(502, `could not resolve base SHA for ${repoSlug}@${targetBranch}`);

  // 5b. Create the promotion branch (idempotent: 422 = it already exists).
  const mkRef = await gh(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: baseSha,
  });
  if (mkRef.status !== 201 && mkRef.status !== 422) {
    ghFail('branch create', repoSlug, mkRef.status, mkRef.json);
  }

  // 5c. Write the file on the branch (create-or-update: a re-run after a
  //     partial promote needs the existing blob SHA to update in place).
  let existingSha: string | undefined;
  const getFile = await gh(token, 'GET', `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`);
  if (getFile.status === 200 && getFile.json?.sha) existingSha = getFile.json.sha as string;

  const put = await gh(token, 'PUT', `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    message: `docs: promote TeamBrain thought ${id8}${t.type ? ` (${t.type})` : ''}`,
    content: toBase64(md),
    branch,
    ...(existingSha ? { sha: existingSha } : {}),
  });
  if (put.status !== 200 && put.status !== 201) ghFail('file commit', repoSlug, put.status, put.json);

  // 5d. Open the PR (idempotent: 422 = a PR for this head/base already exists).
  const title = `docs: promote TeamBrain thought ${id8}${t.type ? ` (${t.type})` : ''}`;
  const prBody = [
    `Promoted from TeamBrain thought \`${t.id}\` (${t.scope} / ${t.type ?? 'thought'}).`,
    '',
    'This PR graduates a stabilized TeamBrain memory into reviewed repo docs via',
    '`promote_to_docs` (Phase 6 § D). Review the content, then merge or close.',
    '',
    t.linked_pr_url ? `Source PR: ${t.linked_pr_url}` : null,
    t.linked_commit_sha ? `Source commit: \`${t.linked_commit_sha}\`` : null,
  ].filter((x) => x !== null).join('\n');

  let prUrl: string | undefined;
  const mkPr = await gh(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
    title, head: branch, base: targetBranch, body: prBody,
  });
  if (mkPr.status === 201) {
    prUrl = mkPr.json?.html_url as string;
  } else if (mkPr.status === 422) {
    // A PR for this head already exists — find and return it.
    const list = await gh(token, 'GET',
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(targetBranch)}`);
    if (list.status === 200 && Array.isArray(list.json) && list.json.length > 0) {
      prUrl = list.json[0].html_url as string;
    } else {
      ghFail('PR open (and no existing PR found)', repoSlug, mkPr.status, mkPr.json);
    }
  } else {
    ghFail('PR open', repoSlug, mkPr.status, mkPr.json);
  }
  if (!prUrl) throw new PromoteError(502, `PR opened on ${repoSlug} but no html_url was returned`);

  // 6. Best-effort stamp: record the PR + bump confidence. A failure here does
  //    not undo the PR — report it but still return ok:true.
  let stamped = false;
  let stampError: string | undefined;
  const { error: stampErr } = await userClient
    .from('thoughts')
    .update({ promoted_pr_url: prUrl, confidence: 'confirmed' })
    .eq('id', t.id);
  if (stampErr) stampError = `${stampErr.message} (code=${stampErr.code ?? 'n/a'})`;
  else stamped = true;

  return {
    ok: true, already_promoted: false,
    pr_url: prUrl, branch, path, repo_slug: repoSlug,
    stamped, ...(stampError ? { stamp_error: stampError } : {}),
  };
}
