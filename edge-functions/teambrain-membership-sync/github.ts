// teambrain-membership-sync/github.ts — GitHub App token mint + the two
// REST endpoints we consume to compute desired membership.
//
// We use a GitHub App installation token rather than a personal access
// token (Phase 3 § A5):
//   * Org-scoped (revocable as a unit, independent of any individual).
//   * Higher rate limit (5000/hr per installation) and isolated from
//     other GitHub work the operator does.
//   * Installation tokens are minted on-demand against a JWT signed
//     by the app's private key. The JWT has a 10-minute max lifetime;
//     installation tokens have a 1-hour lifetime.
//
// We cache the installation token in module scope, refreshing ~5 min
// before expiry. Worker recycling on Edge Runtime means a fresh worker
// just mints a new token on first call — no shared cache layer needed.

import { SignJWT, importPKCS8 } from 'npm:jose@^5.9.0';

// ---------------------------------------------------------------------------
// Env wiring
// ---------------------------------------------------------------------------

const APP_ID          = Deno.env.get('TEAMBRAIN_GITHUB_APP_ID');
const PRIVATE_KEY_PEM = Deno.env.get('TEAMBRAIN_GITHUB_APP_PRIVATE_KEY');
const INSTALLATION_ID = Deno.env.get('TEAMBRAIN_GITHUB_INSTALLATION_ID');

// We require all three at boot time. Fail loud rather than discover at
// first sync that a secret was never wired into the container.
function requireEnv(): { appId: string; pk: string; installationId: string } {
  if (!APP_ID || !PRIVATE_KEY_PEM || !INSTALLATION_ID) {
    throw new Error(
      'teambrain-membership-sync: missing one of ' +
      'TEAMBRAIN_GITHUB_APP_ID / TEAMBRAIN_GITHUB_APP_PRIVATE_KEY / ' +
      'TEAMBRAIN_GITHUB_INSTALLATION_ID',
    );
  }
  return { appId: APP_ID, pk: PRIVATE_KEY_PEM, installationId: INSTALLATION_ID };
}

// ---------------------------------------------------------------------------
// Installation token cache
// ---------------------------------------------------------------------------

interface CachedToken {
  token:     string;
  expiresAt: number;       // ms epoch
}

let cachedToken: CachedToken | null = null;

// Refresh window: 5 min before the 1-hour TTL expires. Avoids a sync
// that starts at minute 59 from racing the token's death.
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

async function mintAppJwt(appId: string, pkPem: string): Promise<string> {
  // GitHub Apps require RS256-signed JWTs. PEM may arrive with literal
  // \n sequences from .env (docker compose unescapes). Normalize.
  const normalized = pkPem.replace(/\\n/g, '\n');
  const key = await importPKCS8(normalized, 'RS256');

  // GitHub allows up to 10-minute lifetimes for app JWTs. We use 9 min
  // to leave clock-skew headroom.
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 30)        // 30s back-dating tolerates skew on GH side
    .setIssuer(appId)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
}

async function fetchInstallationToken(): Promise<CachedToken> {
  const { appId, pk, installationId } = requireEnv();
  const appJwt = await mintAppJwt(appId, pk);

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appJwt}`,
        'Accept':        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`installation-token mint failed: ${resp.status} ${body}`);
  }
  const json = await resp.json() as { token: string; expires_at: string };
  return {
    token:     json.token,
    expiresAt: Date.parse(json.expires_at),
  };
}

export async function getInstallationToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - REFRESH_BEFORE_EXPIRY_MS > now) {
    return cachedToken.token;
  }
  cachedToken = await fetchInstallationToken();
  return cachedToken.token;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export type GitHubPermission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';

export interface CollaboratorRow {
  login:      string;
  permission: GitHubPermission;
}

// Used to surface in the sync report. Set by listCollaborators / listTeamMembers
// after their last paginated call.
export interface RateLimitInfo {
  limit:     number;
  remaining: number;
  reset:     number;       // unix epoch seconds
}

let lastRateLimit: RateLimitInfo | null = null;
export function getLastRateLimit(): RateLimitInfo | null {
  return lastRateLimit;
}

function captureRateLimit(headers: Headers): void {
  const limit     = Number(headers.get('x-ratelimit-limit')     ?? 0);
  const remaining = Number(headers.get('x-ratelimit-remaining') ?? 0);
  const reset     = Number(headers.get('x-ratelimit-reset')     ?? 0);
  if (limit > 0) lastRateLimit = { limit, remaining, reset };
}

// GitHub paginates with Link headers. Walk until no `rel="next"`.
async function paginatedGet<T>(url: string, token: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  while (next) {
    const resp = await fetch(next, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`GET ${next} failed: ${resp.status} ${body}`);
    }
    captureRateLimit(resp.headers);
    const page = await resp.json() as T[];
    out.push(...page);
    next = parseNextLink(resp.headers.get('link'));
  }
  return out;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Format: `<https://api.github.com/...?page=2>; rel="next", <...>; rel="last"`
  for (const entry of linkHeader.split(',')) {
    const m = entry.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

interface RawCollaborator {
  login:    string;
  type?:    string;     // 'User' | 'Bot' — Bot accounts (e.g. dependabot[bot]) excluded
  // The `permissions` object from `/repos/{owner}/{repo}/collaborators`
  // is `{ admin, maintain, push, triage, pull }` booleans. Higher one
  // wins. The string `role_name` field is also present (e.g. "admin",
  // "maintain") but we synthesize from the booleans to be schema-stable.
  permissions: Record<GitHubPermission, boolean>;
}

function highestPermission(p: Record<GitHubPermission, boolean>): GitHubPermission {
  // Order matters: highest-first so the first true wins.
  if (p.admin)    return 'admin';
  if (p.maintain) return 'maintain';
  if (p.push)     return 'push';
  if (p.triage)   return 'triage';
  return 'pull';
}

export type Affiliation = 'all' | 'direct' | 'outside';

// `affiliation` semantics from the GitHub API:
//   * `all`     → outside collaborators + org members with direct access
//                 + team-derived access + default-org-permission + owners.
//                 The broadest set; what `affiliation=` defaults to.
//   * `direct`  → outside collaborators + org members with explicit
//                 repo grants (Settings → Manage Access on the repo).
//                 Excludes default-org-permission and team-derived.
//   * `outside` → outside collaborators only (non-org-members).
//
// `affiliation=all` is the source of TRUTH for permission level (it
// returns the effective per-user permissions object regardless of
// how access was granted).
//
// `affiliation=direct` is the source of ELIGIBILITY for the
// "explicit grant" policy in C-plus: if a project's
// `github_team_slugs` is set, we keep only collaborators who are
// either on a named team OR have an explicit direct grant.
//
// Bots (`type === 'Bot'`) are excluded — they have no auth.users row
// and would only generate `skipped_no_auth_row` noise.
export async function listRepoCollaborators(
  owner: string,
  repo:  string,
  token: string,
  affiliation: Affiliation = 'all',
): Promise<CollaboratorRow[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/collaborators`
            + `?affiliation=${affiliation}&per_page=100`;
  const raw = await paginatedGet<RawCollaborator>(url, token);
  return raw
    .filter((c) => c.type !== 'Bot')
    .map((c) => ({
      login:      c.login,
      permission: highestPermission(c.permissions),
    }));
}

interface RawTeam {
  slug:       string;
  permission: GitHubPermission;
}

interface RawTeamMember {
  login: string;
}

export interface TeamPermission {
  team_slug:  string;
  permission: GitHubPermission;
}

// For an org-team to grant access to a repo, it must be listed in
// `GET /repos/{owner}/{repo}/teams`. The team's `permission` there is
// what every member of that team inherits on the repo. We fetch this
// once per sync and look up each project's `github_team_slugs` against
// the result.
export async function listRepoTeamPermissions(
  owner: string,
  repo:  string,
  token: string,
): Promise<TeamPermission[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/teams?per_page=100`;
  const raw = await paginatedGet<RawTeam>(url, token);
  return raw.map((t) => ({ team_slug: t.slug, permission: t.permission }));
}

export async function listTeamMembers(
  org:      string,
  teamSlug: string,
  token:    string,
): Promise<string[]> {
  const url = `https://api.github.com/orgs/${org}/teams/${teamSlug}/members?per_page=100`;
  const raw = await paginatedGet<RawTeamMember>(url, token);
  return raw.map((m) => m.login);
}
