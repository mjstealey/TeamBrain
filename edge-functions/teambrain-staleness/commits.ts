// teambrain-staleness/commits.ts — GitHub commit/compare reads for the
// Phase 6 § C staleness poller. Mirrors the fetch + headers pattern in
// teambrain-membership-sync/github.ts; each call takes an installation token
// (minted by that module's getInstallationToken()).
//
// Requires the GitHub App to have **Contents: read** permission — broader than
// the Members/Metadata membership-sync uses. If the App lacks it, getRepoHead /
// compareChangedPaths return 403 and the scan reports the repo as errored
// (it does not flag anything).

const GH = 'https://api.github.com';

function ghHeaders(token: string): HeadersInit {
  return {
    'Authorization':        `Bearer ${token}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export interface RepoHead {
  defaultBranch: string;
  headSha:       string;
}

// Resolve a repo's default branch and the current HEAD commit sha on it.
export async function getRepoHead(
  owner: string,
  repo:  string,
  token: string,
): Promise<RepoHead> {
  const repoResp = await fetch(`${GH}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });
  if (!repoResp.ok) {
    throw new Error(`GET repo ${owner}/${repo} failed: ${repoResp.status} ${await repoResp.text()}`);
  }
  const repoJson = await repoResp.json() as { default_branch: string };
  const branch = repoJson.default_branch;

  const headResp = await fetch(
    `${GH}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
    { headers: ghHeaders(token) },
  );
  if (!headResp.ok) {
    throw new Error(`GET head ${owner}/${repo}@${branch} failed: ${headResp.status} ${await headResp.text()}`);
  }
  const headJson = await headResp.json() as { sha: string };
  return { defaultBranch: branch, headSha: headJson.sha };
}

export interface ChangedFiles {
  paths:       string[];
  truncated:   boolean;       // true if GitHub capped the file list (300)
  commitCount: number;
}

// Compare base...head and aggregate the distinct changed-file paths. GitHub's
// compare endpoint returns at most 300 files; `truncated` flags that cap so the
// caller can log a partial scan rather than silently miss paths.
export async function compareChangedPaths(
  owner: string,
  repo:  string,
  base:  string,
  head:  string,
  token: string,
): Promise<ChangedFiles> {
  const resp = await fetch(
    `${GH}/repos/${owner}/${repo}/compare/${base}...${head}?per_page=100`,
    { headers: ghHeaders(token) },
  );
  if (!resp.ok) {
    throw new Error(`GET compare ${base}...${head} failed: ${resp.status} ${await resp.text()}`);
  }
  const json = await resp.json() as {
    files?:         { filename: string }[];
    commits?:       unknown[];
    total_commits?: number;
  };
  const files = json.files ?? [];
  const paths = Array.from(new Set(files.map((f) => f.filename)));
  return {
    paths,
    truncated:   files.length >= 300,
    commitCount: json.total_commits ?? (json.commits?.length ?? 0),
  };
}
