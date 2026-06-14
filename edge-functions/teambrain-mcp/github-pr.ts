// github-pr.ts — a small, generic "commit files on a branch and open a PR"
// helper over the GitHub Contents/Git/Pulls REST API, authenticated with the
// TeamBrain App installation token.
//
// This generalizes the branch -> PUT -> PR sequence that promote.ts (Phase 6
// § D) hard-codes for a single ADR file, so teambrain-console's /setup-pr can
// open ONE PR that adds several files (the capture-on-merge workflow + a
// generated AGENTS.md). promote.ts is intentionally left on its own copy for
// now (it's prod-verified); migrating it onto this module is a later cleanup.
//
// The GitHub App needs **Contents: write** + **Pull requests: write** on the
// target repo — the same grant promote_to_docs relies on. A 403/404 on a write
// almost always means that grant is missing or the App isn't installed on the
// repo; GitHubPrError says so rather than echoing a bare status.
//
// Idempotency (so a re-run never duplicates): branch create tolerates 422
// (already exists), each file PUT reads the existing blob SHA and updates in
// place, and PR open treats 422 as "a PR for this head already exists" and
// returns it.

const GH_API = 'https://api.github.com';

export class GitHubPrError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GitHubPrError';
  }
}

export interface PrFile {
  path:    string;   // repo-relative, e.g. '.github/workflows/capture-on-merge.yml'
  content: string;   // UTF-8 text; base64-encoded for the Contents API
}

export interface CommitAndPrOptions {
  branch:  string;   // head branch to create off `base`
  base:    string;   // base branch, e.g. 'main'
  files:   PrFile[];
  title:   string;
  body:    string;
}

export interface CommitAndPrResult {
  pr_url:         string;
  branch:         string;
  base:           string;
  files_written:  string[];
  already_existed: boolean;   // true if the PR for this head/base already existed
}

async function gh(
  token:  string,
  method: string,
  path:   string,
  body?:  unknown,
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

function ghFail(stage: string, repo: string, status: number, json: any): never {
  const ghMsg = json?.message ?? json?.raw ?? '(no body)';
  if (status === 403 || status === 404) {
    // Committing a file under .github/workflows/ requires the App's *Workflows*
    // permission specifically — "Contents: write" alone returns 403 there
    // ("Resource not accessible by integration"), which is easy to misread as a
    // Contents-permission problem. Name the right scope when the path says so.
    const isWorkflow = stage.includes('.github/workflows/');
    const need = isWorkflow
      ? '"Workflows: write" (a SEPARATE permission from Contents — required for ' +
        'any .github/workflows/ file), plus "Contents: write" + "Pull requests: write"'
      : '"Contents: write" + "Pull requests: write"';
    throw new GitHubPrError(
      502,
      `GitHub ${stage} failed (${status}) on ${repo}: ${ghMsg}. The TeamBrain ` +
      `GitHub App likely needs ${need} on this repo (and must be installed on it). ` +
      `Permission changes also require the org to accept the request on the installation.`,
    );
  }
  throw new GitHubPrError(502, `GitHub ${stage} failed (${status}) on ${repo}: ${ghMsg}`);
}

// UTF-8-safe base64 for the Contents API (same trick as promote.ts — avoids a
// large spread that can overflow the call stack on big inputs).
function toBase64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export async function commitFilesAndOpenPR(
  token: string,
  owner: string,
  repo:  string,
  opts:  CommitAndPrOptions,
): Promise<CommitAndPrResult> {
  const { branch, base, files, title, body } = opts;
  const repoSlug = `${owner}/${repo}`;
  if (files.length === 0) throw new GitHubPrError(400, 'commitFilesAndOpenPR: no files to commit');

  // 1. Base branch SHA.
  const baseRef = await gh(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  if (baseRef.status !== 200) ghFail(`base-branch lookup (${base})`, repoSlug, baseRef.status, baseRef.json);
  const baseSha = baseRef.json?.object?.sha as string | undefined;
  if (!baseSha) throw new GitHubPrError(502, `could not resolve base SHA for ${repoSlug}@${base}`);

  // 2. Create the head branch (idempotent: 422 = it already exists).
  const mkRef = await gh(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: baseSha,
  });
  if (mkRef.status !== 201 && mkRef.status !== 422) {
    ghFail('branch create', repoSlug, mkRef.status, mkRef.json);
  }

  // 3. Write each file on the branch (create-or-update via existing blob SHA).
  const written: string[] = [];
  for (const f of files) {
    const cleanPath = f.path.replace(/^\/+/, '');
    let existingSha: string | undefined;
    const getFile = await gh(
      token, 'GET',
      `/repos/${owner}/${repo}/contents/${encodeURI(cleanPath)}?ref=${encodeURIComponent(branch)}`,
    );
    if (getFile.status === 200 && getFile.json?.sha) existingSha = getFile.json.sha as string;

    const put = await gh(token, 'PUT', `/repos/${owner}/${repo}/contents/${encodeURI(cleanPath)}`, {
      message: `${title} — ${cleanPath}`,
      content: toBase64(f.content),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    });
    if (put.status !== 200 && put.status !== 201) ghFail(`file commit (${cleanPath})`, repoSlug, put.status, put.json);
    written.push(cleanPath);
  }

  // 4. Open the PR (idempotent: 422 = a PR for this head/base already exists).
  let prUrl: string | undefined;
  let alreadyExisted = false;
  const mkPr = await gh(token, 'POST', `/repos/${owner}/${repo}/pulls`, {
    title, head: branch, base, body,
  });
  if (mkPr.status === 201) {
    prUrl = mkPr.json?.html_url as string;
  } else if (mkPr.status === 422) {
    alreadyExisted = true;
    const list = await gh(
      token, 'GET',
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}`,
    );
    if (list.status === 200 && Array.isArray(list.json) && list.json.length > 0) {
      prUrl = list.json[0].html_url as string;
    } else {
      ghFail('PR open (and no existing PR found)', repoSlug, mkPr.status, mkPr.json);
    }
  } else {
    ghFail('PR open', repoSlug, mkPr.status, mkPr.json);
  }
  if (!prUrl) throw new GitHubPrError(502, `PR opened on ${repoSlug} but no html_url was returned`);

  return { pr_url: prUrl, branch, base, files_written: written, already_existed: alreadyExisted };
}
