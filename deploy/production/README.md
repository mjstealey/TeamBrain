# TeamBrain — Production deploy runbook (`pr.fabric-testbed.net`)

This directory contains the production-specific deploy artifacts and the procedure to assemble them with upstream Supabase docker-compose into a working TeamBrain stack on `pr.fabric-testbed.net`.

The scratch/dev stack on a developer laptop is **not** the deploy unit. The four artifacts that make up a working TeamBrain instance live in four different sources:

| What | Source | Lives where on the VM |
|---|---|---|
| Supabase docker-compose, init scripts, image pins | Upstream `supabase/supabase/docker/` (cloned fresh) | `/opt/supabase-stack/` |
| TeamBrain customizations (override, env additions, runbook) | This directory | Copied/merged into `/opt/supabase-stack/` |
| Secrets (`.env`), TLS certs, named-volume data | Generated/issued on the VM | `/opt/supabase-stack/.env`, docker named volumes |
| Edge-function source (TS, deno.json) | TeamBrain repo `edge-functions/` | `/opt/supabase-stack/volumes/functions/<name>/` (rsync'd) |

The procedure below assembles these in order. Each step has an explicit verification command — do not move past a step until its verification passes.

---

## 0. Prerequisites

Before SSHing to the VM, confirm:

- [ ] **VM provisioned.** Target spec: 4 vCPU / 8 GB RAM / 50 GB disk. Modern Linux (Ubuntu 22.04 LTS, 24.04 LTS, or Rocky/RHEL 9 all work).
- [ ] **DNS.** `pr.fabric-testbed.net` A/AAAA records point at the VM's public IP. Verify externally: `dig +short pr.fabric-testbed.net` returns the right IP. Let's Encrypt's HTTP-01 challenge fails without correct DNS *before* the first `up -d`.
- [ ] **Firewall.** Ports 80/tcp and 443/tcp (and 443/udp for HTTP/3) open to the world. Port 22 open to your admin source. All other ports closed.
- [ ] **GitHub OAuth App (production).** Registered under `fabric-testbed` org with `Authorization callback URL = https://pr.fabric-testbed.net/auth/v1/callback`. App name `TeamBrain (production)`. Client ID + secret captured. Distinct from the scratch OAuth App. See `docs/deployment.md` § "GitHub OAuth App".
- [ ] **GitHub Sync App (production).** Registered as `TeamBrain Sync — fabric-testbed` (no `(dev)` suffix). Permissions: Repository → Metadata: Read; Organization → Members: Read. Webhook disabled. Installed on the org with the pilot repo selected. App ID + installation ID + PKCS#8-converted private key captured. Distinct from the scratch Sync App per `docs/deployment.md` § "Scratch vs production: register two Apps".
- [ ] **OpenAI API key** (production-billed; not a personal account) **or** decision to run the ollama embedding variant.
- [ ] **DNS for `pr.fabric-testbed.net`** has propagated. (You can `dig` from a non-VM host to verify before deploying.)

If any precondition fails, fix it before proceeding — production install is not the place to debug DNS.

---

## 1. Install Docker and Compose

```bash
ssh root@pr.fabric-testbed.net
# Or whatever account has sudo + docker group on the VM.

# Ubuntu / Debian:
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Rocky / RHEL:
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

Verify:

```bash
docker --version           # expect 24.x or newer
docker compose version     # expect v2.20+
```

---

## 2. Clone upstream Supabase docker subtree

```bash
git clone --depth=1 https://github.com/supabase/supabase /tmp/sb
mv /tmp/sb/docker /opt/supabase-stack
rm -rf /tmp/sb

cd /opt/supabase-stack
ls
# expect: docker-compose.yml, docker-compose.caddy.yml, .env.example,
#         volumes/, dev/, utils/, ...
```

Note the commit hash so this deploy is reproducible:

```bash
git -C /tmp/sb rev-parse HEAD 2>/dev/null || \
  curl -s https://api.github.com/repos/supabase/supabase/commits/master | \
  python3 -c 'import sys,json; print(json.load(sys.stdin)["sha"])'
# Save this somewhere — it's the upstream pin for this install.
```

---

## 3. Clone TeamBrain

```bash
git clone https://github.com/mjstealey/TeamBrain /opt/teambrain
cd /opt/teambrain
git log -1 --oneline    # capture the TeamBrain commit hash too
```

---

## 4. Layer in TeamBrain's production overrides

```bash
# Production override (TeamBrain env passthrough + Postgres 17 + kong loopback bind):
cp /opt/teambrain/deploy/production/docker-compose.override.yml \
   /opt/supabase-stack/docker-compose.override.yml

# Seed .env from upstream, then mint fresh secrets:
cd /opt/supabase-stack
cp .env.example .env
bash utils/generate-keys.sh
```

`generate-keys.sh` overwrites placeholder `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DASHBOARD_PASSWORD`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`, and a few others with cryptographically random values. **Save the generated `DASHBOARD_PASSWORD` to your password manager immediately** — you'll need it to access Studio.

Verify the secret block exists and is non-default:

```bash
grep -E '^(JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY)=' .env | \
  awk -F= '{printf "%s = <%d chars>\n", $1, length($0)-length($1)-1}'
# expect three lines, each value >32 chars
```

---

## 5. Configure `.env` (must-edit values)

Open `/opt/supabase-stack/.env` and set the values documented in `/opt/teambrain/deploy/production/env.template`. The short list:

| Key | Value | Source |
|---|---|---|
| `PROXY_DOMAIN` | `pr.fabric-testbed.net` | DNS |
| `SUPABASE_PUBLIC_URL` | `https://pr.fabric-testbed.net` | derived |
| `API_EXTERNAL_URL` | `https://pr.fabric-testbed.net` | derived |
| `SITE_URL` | `https://pr.fabric-testbed.net` | derived |
| `CERTBOT_EMAIL` | a monitored email | Let's Encrypt registration |
| `GITHUB_CLIENT_ID` | from the production OAuth App | Prerequisites |
| `GITHUB_SECRET` | from the production OAuth App | Prerequisites |
| `OPENAI_API_KEY` | production-billed OpenAI key | Prerequisites |

Then **append** the TeamBrain Phase 3 block (it is not in upstream's `.env.example`):

```
# TeamBrain — Phase 3 GitHub-membership-sync App credentials
TEAMBRAIN_GITHUB_APP_ID=<from the production Sync App>
TEAMBRAIN_GITHUB_INSTALLATION_ID=<from the post-install URL>
TEAMBRAIN_GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv…\n-----END PRIVATE KEY-----\n"
```

The PEM must be PKCS#8 (`-----BEGIN PRIVATE KEY-----`, **no "RSA"**). GitHub ships PKCS#1 by default — convert with:

```bash
openssl pkcs8 -topk8 -in <github-download>.pem -out teambrain-sync.pkcs8.pem -nocrypt
awk 'BEGIN{ORS="\\n"} {print}' teambrain-sync.pkcs8.pem
# Paste the single-line output, wrapped in double quotes.
```

Verify (mask values):

```bash
grep -E '^(PROXY_DOMAIN|CERTBOT_EMAIL|GITHUB_CLIENT_ID|GITHUB_SECRET|OPENAI_API_KEY|TEAMBRAIN_GITHUB_)' /opt/supabase-stack/.env | \
  awk -F= '{printf "%s = <%d chars>\n", $1, length($0)-length($1)-1}'
# expect 7+ lines, none with 0 chars
```

---

## 6. First boot

```bash
cd /opt/supabase-stack

# `-f docker-compose.yml -f docker-compose.caddy.yml` loads the caddy
# overlay; `docker-compose.override.yml` auto-merges last and wins.
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
docker compose ps
# expect every service Healthy or Started; caddy will be `restarting`
# briefly while Let's Encrypt issues the first cert.
```

Verify TLS issuance:

```bash
docker compose logs caddy --tail 50 | grep -iE 'certificate|obtained'
# expect a "certificate obtained successfully" line within ~60 s of
# first boot. If it errors, common causes:
#   * DNS not propagated yet → wait, retry
#   * Port 80 blocked → unblock at the firewall
#   * CERTBOT_EMAIL invalid → fix .env, `docker compose up -d --force-recreate caddy`
```

External smoke:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://pr.fabric-testbed.net/auth/v1/health
# expect: 200
```

---

## 7. Apply Phase 1–2 migrations via Studio

Studio is gated behind Caddy basic-auth (username `supabase`, password = `DASHBOARD_PASSWORD` you saved in step 4). Visit:

```
https://pr.fabric-testbed.net
```

Authenticate with the basic-auth credentials. You should see Studio's project view.

In **SQL Editor → New query**, paste each migration's full contents from `/opt/teambrain/migrations/` and click **Run**. Apply in this order:

```
0001_init.sql
0002_rls.sql
0003_disable_graphql.sql
0004_match_thoughts.sql
[0005_resize_embedding_768.sql — only if running the ollama variant]
0006_embedding_model.sql
```

After each, run the verification queries from `docs/phase-1-checklist.md` § B/C/D/E and `docs/phase-2-checklist.md` § B/L as a check. Expect Studio's **Security Advisor: 0 errors / 0 warnings** and **Performance Advisor: 0 issues** after `0003`. If anything else is red, stop and triage.

---

## 8. Deploy the edge functions

From your **local laptop**, rsync the function source to the VM. (Doing this from the VM's TeamBrain checkout works too, but the laptop is the authoritative source — rsync from there avoids the "I edited on the VM and the repo never saw it" drift trap.)

```bash
# From your laptop:
rsync -av --delete \
  ~/GitHub/mjstealey/TeamBrain/edge-functions/teambrain-mcp/ \
  root@pr.fabric-testbed.net:/opt/supabase-stack/volumes/functions/teambrain-mcp/

rsync -av --delete \
  ~/GitHub/mjstealey/TeamBrain/edge-functions/teambrain-membership-sync/ \
  root@pr.fabric-testbed.net:/opt/supabase-stack/volumes/functions/teambrain-membership-sync/
```

Then on the VM, recreate the functions container so it sees the new dirs:

```bash
cd /opt/supabase-stack
docker compose up -d --force-recreate functions
docker compose logs functions --tail 30
```

Verify the functions container picked up the TeamBrain env vars:

```bash
docker compose exec functions env | grep -E '^(EMBEDDING_|OPENAI_|TEAMBRAIN_)' | \
  awk -F= '{printf "%s = <%d chars>\n", $1, length($0)-length($1)-1}'
# expect: EMBEDDING_PROVIDER, EMBEDDING_DIMS, OPENAI_API_KEY,
#         OPENAI_EMBEDDING_MODEL, TEAMBRAIN_DEFAULT_PROJECT_SLUG,
#         TEAMBRAIN_GITHUB_APP_ID, TEAMBRAIN_GITHUB_INSTALLATION_ID,
#         TEAMBRAIN_GITHUB_APP_PRIVATE_KEY (>1500 chars for PEM)
```

---

## 9. MCP smoke test (Phase 2)

```bash
ANON_KEY=$(grep '^ANON_KEY=' /opt/supabase-stack/.env | cut -d= -f2)

curl -sS -X POST \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp
# expect: a JSON-RPC response listing six tools (ping, capture_project_thought,
# search_project_thoughts, list_recent_project_thoughts, mark_stale, promote_to_docs).
```

The MCP function rejects requests authenticated only by the anon key for any tool that touches RLS-scoped data — that's expected. The `tools/list` method is auth-light.

For an end-to-end RLS smoke test, log in once via the web (sign in with GitHub at `https://pr.fabric-testbed.net`), grab a user JWT from the browser dev tools, and re-curl with that bearer. See `docs/phase-2-checklist.md` § H for the full curl matrix.

---

## 10. Apply Phase 3 migrations + seed

In Studio SQL Editor, apply:

```
seed.sql                                # creates the projects row and seeds
                                        # the initial admin (mjstealey) — keep
                                        # this so the sync has something to
                                        # reconcile against.
0007_projects_github_teams.sql
0008_project_members_soft_delete.sql
0009_sync_runs.sql
```

Then populate the team slug:

```sql
update public.projects
set github_team_slugs = array['systemservicesteam']
where repo_slug = 'fabric-testbed/fabric-core-api';
```

---

## 11. Phase 3 smoke test (on-demand sync)

```bash
SERVICE_KEY=$(grep '^SERVICE_ROLE_KEY=' /opt/supabase-stack/.env | cut -d= -f2)

curl -sS -X POST \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  "http://127.0.0.1:8000/functions/v1/teambrain-membership-sync/sync?project_slug=fabric-testbed/fabric-core-api" \
  | python3 -m json.tool
# expect (with no humans logged in yet):
#   github_collaborators_seen: 14
#   github_team_members_seen:  4
#   added:    []  (mjstealey was seeded with the right role)
#   updated:  []  removed: [] restored: []
#   skipped_no_auth_row: [{login: ibaldin}, {login: kthare10}, {login: yaxue1123}]
```

The 127.0.0.1 bind on Kong is for on-VM-only testing. If you'd rather go through Caddy + basic auth:

```bash
curl -sS -u "supabase:$DASHBOARD_PASSWORD" -X POST \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  "https://pr.fabric-testbed.net/functions/v1/teambrain-membership-sync/sync?project_slug=fabric-testbed/fabric-core-api"
```

Wait — actually `/functions/v1/*` is in upstream's Caddyfile `@supabase_api` matcher and is NOT basic-auth'd. The basic auth only fronts Studio. The internal curl works directly:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  "https://pr.fabric-testbed.net/functions/v1/teambrain-membership-sync/sync?project_slug=fabric-testbed/fabric-core-api"
```

Then verify the audit row landed in Studio:

```sql
select started_at, ok, jsonb_pretty(report) as report, error
from public.sync_runs
order by started_at desc
limit 1;
```

---

## 12. Schedule the recurring sync (pg_cron)

The two GUCs the cron schedule reads:

```sql
-- In Studio SQL Editor (run as supabase_admin):
alter database postgres set app.teambrain_sync_url =
  'http://kong:8000/functions/v1/teambrain-membership-sync/sync-all';

alter database postgres set app.teambrain_service_role_key =
  '<paste SERVICE_ROLE_KEY value from .env>';
```

Then apply the schedule:

```
0010_pg_cron_membership_sync.sql
```

Verify:

```sql
select jobid, schedule, jobname from cron.job where jobname = 'teambrain-membership-sync';
-- expect 1 row, schedule = '*/15 * * * *'
```

Wait ~15 minutes past a quarter-hour boundary, then:

```sql
-- Did the cron worker fire?
select start_time, status, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'teambrain-membership-sync')
order by start_time desc
limit 5;
-- expect: 1+ rows, status = 'succeeded', return_message like '%http_post%request_id%'

-- Did the sync function process it?
select started_at, project_id is null as is_aggregate, ok, error
from public.sync_runs
order by started_at desc
limit 5;
-- expect: rows landing every 15 min; latest is an aggregate (project_id IS NULL)
```

---

## 13. Hand-off to Komal

Once steps 1–12 are green:

> Komal — please visit `https://pr.fabric-testbed.net`, click "Sign in with GitHub," approve the OAuth App authorization. That's it. Within 15 minutes the scheduled sync will add your `project_members` row. To force it sooner, ping Michael to run the on-demand `/sync` curl.

Verify after she logs in:

```sql
-- Did GoTrue create the row?
select id, email, raw_user_meta_data->>'user_name' as gh_handle, created_at
from auth.users
where raw_user_meta_data->>'user_name' = 'kthare10';
-- expect 1 row

-- After the next sync, is she in project_members?
select pm.role, pm.removed_at, u.raw_user_meta_data->>'user_name' as gh_handle
from public.project_members pm
join auth.users u on u.id = pm.user_id
where pm.project_id = '00000000-0000-0000-0000-00000000c0a1'::uuid;
-- expect 2 rows: mjstealey (admin) and kthare10 (contributor)
```

That completes Phase 3 sign-off.

---

## Operations

### Backups

A nightly `pg_dump` from inside the `db` container, encrypted, copied to FABRIC NFS or an S3-compatible bucket:

```bash
# Example backup script (place in /opt/backups/backup-supabase.sh, run via systemd timer):
#!/bin/bash
set -euo pipefail
DEST=/opt/backups/$(date +%Y-%m-%d).sql.gz
docker compose -f /opt/supabase-stack/docker-compose.yml exec -T db \
  pg_dump -U postgres -d postgres | gzip > "$DEST"
# Then rsync to your offsite location.
```

Keep at least 14 days of dumps; PITR via pgBackRest or Barman is a Phase-7+ upgrade if it becomes warranted.

### Upgrades

1. Subscribe to `https://github.com/supabase/supabase/releases` (or check `versions.md` in the docker subtree). Track upstream tags, never `:latest`.
2. Test the upgrade against scratch first.
3. `pg_dump` immediately before upgrading prod.
4. Pull new images, re-deploy: `docker compose pull && docker compose up -d`.
5. Run all migration verification queries from scratch (`docs/phase-{1,2,3}-checklist.md` verification sections) against prod after upgrade.

### Rollback (Phase 3 sync)

If a sync produces wrong diffs (e.g. a misconfigured GitHub App over-privileges users):

```sql
-- 1. Halt the schedule.
select cron.unschedule('teambrain-membership-sync');

-- 2. Inspect.
select * from public.sync_runs order by started_at desc limit 10;

-- 3. Revert role: update public.project_members set role = '<old>'
--    where project_id = '…' and user_id = '…';

-- 4. Restore tombstoned: update public.project_members set removed_at = null where ...;
```

Soft-delete means every recovery is an UPDATE — no row-recovery procedure to document.

### Rotating GitHub App credentials

1. In the production App's settings → Private keys → **Generate a private key**. Don't revoke the old key yet.
2. Convert to PKCS#8 (`openssl pkcs8 -topk8 ...`).
3. Update `TEAMBRAIN_GITHUB_APP_PRIVATE_KEY` in `/opt/supabase-stack/.env`.
4. `cd /opt/supabase-stack && docker compose up -d --force-recreate functions`.
5. Trigger an on-demand `/sync` — verify a 200 with a real diff/report.
6. Revoke the old key from the App settings.

If the new key fails, the old key still works during step 4 since key revocation is decoupled from key rotation. Always validate before revoking.

---

## Troubleshooting

### Caddy keeps restarting / no cert obtained

- Check `docker compose logs caddy --tail 100`.
- `dig +short pr.fabric-testbed.net` — must return the VM IP from an *external* host. ACME challenge originates from Let's Encrypt's servers, not from inside the VM.
- Firewall: `nc -zv pr.fabric-testbed.net 80` from outside the VM must succeed.
- Rate limit: Let's Encrypt allows 5 cert attempts per hostname per week. If you've been retrying, wait or use `--staging` via the `LEGO_CA_SYSTEM_CERT_POOL` / `CADDY_ACME_CA` envs (consult upstream caddy overlay docs).

### `Authorization` header rejected by edge function

- Wrong key. The functions worker rejects:
  - missing `Authorization` → 401
  - JWT with `role != service_role` (for membership-sync `/sync` and `/sync-all`) → 403
- Make sure `$SERVICE_KEY` came from `^SERVICE_ROLE_KEY=` in `.env`, not `^ANON_KEY=` or `^SUPABASE_SECRET_KEY=`.

### `installation-token mint failed: 401 ... A JSON web token could not be decoded`

- PEM is PKCS#1, not PKCS#8. Re-run `openssl pkcs8 -topk8` on the original `.pem` and re-paste.
- Or the env var got truncated to the first line. Verify with `docker compose exec functions sh -c 'printf "%s" "$TEAMBRAIN_GITHUB_APP_PRIVATE_KEY" | wc -c'` — expect ~1700.

### `installation-token mint failed: 404`

- `TEAMBRAIN_GITHUB_INSTALLATION_ID` typo, or the App was never installed on the org.
- Verify at `https://github.com/organizations/fabric-testbed/settings/installations` — the URL of the install includes the ID.

### Sync runs but `removed` contains unexpected entries

- Likely the wrong policy active. Check `select repo_slug, github_team_slugs from public.projects;` — if `github_team_slugs` is empty, the sync uses `affiliation=all` (broadest possible eligibility) and will tombstone existing seeded members who aren't in that set.
- Restore: `update public.project_members set removed_at = null where ...;` then set `github_team_slugs` to the intended team.

### "could not find an appropriate entrypoint" worker boot error

- The function's source isn't actually present at `/opt/supabase-stack/volumes/functions/<name>/`. Re-rsync from your laptop and `docker compose restart functions`.

---

## Source-of-truth pointers

| Topic | File |
|---|---|
| Architectural decisions (ADR) | `docs/adr/0001-teambrain-architecture.md` |
| Phase-by-phase deploy notes | `docs/deployment.md` |
| Phase 1 verification matrix | `docs/phase-1-checklist.md` § B/C/D/E |
| Phase 2 verification matrix | `docs/phase-2-checklist.md` § H/L |
| Phase 3 verification matrix | `docs/phase-3-checklist.md` § G |
| Production overrides (this dir) | `deploy/production/` |
| Edge-function source | `edge-functions/{teambrain-mcp,teambrain-membership-sync}/` |
| Migrations | `migrations/` (README inside the dir) |
