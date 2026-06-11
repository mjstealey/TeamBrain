# TeamBrain — Production deploy runbook (`pr.fabric-testbed.net`)

This directory contains the production-specific deploy artifacts and the procedure to assemble them with upstream Supabase docker-compose into a working TeamBrain stack on `pr.fabric-testbed.net`.

The scratch/dev stack on a developer laptop is **not** the deploy unit. The four artifacts that make up a working TeamBrain instance live in four different sources:

| What | Source | Lives where on the VM |
|---|---|---|
| Supabase docker-compose, init scripts, image pins | Upstream `supabase/supabase/docker/` (cloned fresh) | `~nrig-service/supabase-stack/` |
| TeamBrain customizations (override, env additions, runbook) | This directory | Copied/merged into `~nrig-service/supabase-stack/` |
| Secrets (`.env`), TLS certs, named-volume data | Generated/issued on the VM | `~nrig-service/supabase-stack/.env`, docker named volumes |
| Edge-function source (TS, deno.json) | TeamBrain repo `edge-functions/` | `~nrig-service/supabase-stack/volumes/functions/<name>/` |

The procedure below assembles these in order. Each step has an explicit verification command — do not move past a step until its verification passes.

**Account convention:** the entire stack runs as the `nrig-service` service account on `pr.fabric-testbed.net`. Every subsequent shell command that uses `~/` assumes you're shelled in as that user — typically `ssh <vm>` (as a sudoer like `stealey`) followed by `sudo -iu nrig-service`. If you're deploying to a different VM under a different service account, substitute that home throughout.

---

## TLS termination: choose a path

TeamBrain's production deploy supports two TLS-termination strategies. Both are equally supported; the choice is a property of the VM and the operating environment, not of TeamBrain itself.

| | **Path A — Caddy (managed Let's Encrypt)** | **Path B — Compose-managed nginx + institutional cert** |
|---|---|---|
| Cert source | Caddy mints from Let's Encrypt via HTTP-01 at first boot | Issued out-of-band (e.g. UNC InCommon, internal CA) and placed on disk before deploy |
| Cert lifecycle | Auto-renewed by Caddy every ~60d | Renewed by whoever issues the cert; you replace the file on disk and reload nginx |
| Outbound :80 to ACME | Required | Not required |
| Inbound :80 / :443 | Bound by Caddy container | Bound by an `nginx` service from `docker-compose.nginx.yml` (this repo); Caddy is NOT deployed |
| Studio gating | Caddy basic-auth (`DASHBOARD_PASSWORD`) | SSH-tunnel to Kong's loopback bind until vouch-proxy + CILogon is layered in |
| Compose invocation | `docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d` | `docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d` |
| Typical fit | Cloud / DigitalOcean / Hetzner / Linode VMs where you control the network and ACME works freely | Institutional / on-prem VMs that already hold a managed cert and don't want to delegate cert issuance to Let's Encrypt (e.g. `pr.fabric-testbed.net`) |

**`pr.fabric-testbed.net` uses Path B.** The VM has an institutional FABRIC SAN cert at `/root/cert/fabric-other-services_fabric-testbed_net.pem` (renewed out-of-band by the VM owner). The stack's own `nginx` service bind-mounts that cert read-only and terminates TLS for the public hostname — no Let's Encrypt, no separate host-side reverse-proxy to coordinate with.

Steps 1–5 and 8–13 below are identical for both paths. Steps 6 (first boot), 7 (Studio access), and the auth note inside step 11 split by path — each has explicit "Path A" / "Path B" subsections.

---

## 0. Prerequisites

Before SSHing to the VM, confirm:

- [ ] **TLS path chosen** (see § "TLS termination: choose a path" above). The rest of this checklist branches by choice.
- [ ] **VM provisioned.** Target spec: 4 vCPU / 8 GB RAM / 50 GB disk. Modern Linux (Ubuntu 22.04 LTS, 24.04 LTS, or Rocky/RHEL 9 all work).
- [ ] **DNS.** Public hostname A/AAAA records point at the VM's public IP. Verify externally: `dig +short <hostname>` returns the right IP. *Path A only:* Let's Encrypt's HTTP-01 challenge fails without correct DNS *before* the first `up -d`. *Path B:* DNS still needs to be right for clients and OAuth callbacks, but ACME is not in the loop.
- [ ] **Firewall.**
   - *Path A:* Ports 80/tcp and 443/tcp (and 443/udp for HTTP/3) open to the world for Caddy + LE. Port 22 open to your admin source.
   - *Path B:* Ports 80/tcp and 443/tcp open to whoever needs the API. Port 22 open to your admin source. Outbound 80 to ACME servers not required.
- [ ] **TLS cert in place** (*Path B only*). Institutional cert + key on disk at `/root/cert/` (or wherever you choose to place them — the bind path is hard-coded to `/root/cert` in `docker-compose.nginx.yml`; change it there if you put the cert elsewhere). On `pr.fabric-testbed.net` that's `/root/cert/fabric-other-services_fabric-testbed_net.pem` + `/root/cert/fabric-other-services.key`. SAN must cover the public hostname. Verify with `openssl x509 -in <cert> -noout -text | grep -A1 'Subject Alternative Name'`. If your cert filenames differ from the FABRIC defaults, update the `ssl_certificate` / `ssl_certificate_key` lines in `deploy/production/nginx/conf.d/pr.fabric-testbed.net.conf` to match.
- [ ] **Host :80 and :443 are free** (*Path B only*). `ss -tlnp '( sport = :80 or sport = :443 )'` from the VM returns no listeners. The compose-managed `nginx` service publishes both ports; anything else parked on them will refuse the bind. (On `pr.fabric-testbed.net` an earlier placeholder nginx container previously held these — it has since been removed.)
- [ ] **GitHub OAuth App (production).** Registered under `fabric-testbed` org with `Authorization callback URL = https://<hostname>/auth/v1/callback`. App name `TeamBrain (production)`. Client ID + secret captured. Distinct from the scratch OAuth App. The callback URL is the same for both paths — it resolves via whichever reverse-proxy is fronting `:443`. See `docs/deployment.md` § "GitHub OAuth App".
- [ ] **GitHub Sync App (production).** Registered as `TeamBrain Sync — fabric-testbed` (no `(dev)` suffix). Permissions: Repository → Metadata: Read; Organization → Members: Read. Webhook disabled. Installed on the org with the pilot repo selected. App ID + installation ID + PKCS#8-converted private key captured. Distinct from the scratch Sync App per `docs/deployment.md` § "Scratch vs production: register two Apps".
- [ ] **OpenAI API key** **or** decision to run the ollama embedding variant. Production-billed key (separate from any personal account) is preferred for cost attribution and key-rotation isolation, but a personal key is acceptable for the pilot — cost is ~$0.02 per 1M tokens for `text-embedding-3-small`, effectively free at pilot scale. Plan to rotate to a project-scoped key before opening the pilot beyond the initial reviewer set.
- [ ] **DNS for the public hostname** has propagated. (You can `dig` from a non-VM host to verify before deploying.)

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

**Skip if already done** — `pr.fabric-testbed.net` already has `~/supabase-stack/` populated and the pinned SHA recorded in `~/supabase-stack-sha.txt`. Verify with `cat ~/supabase-stack-sha.txt`; if it shows a `supabase:` line, the subtree is in place and you can proceed to §3.

For a fresh deploy:

```bash
git clone --depth=1 https://github.com/supabase/supabase /tmp/sb
mv /tmp/sb/docker ~/supabase-stack
rm -rf /tmp/sb

cd ~/supabase-stack
ls
# expect: docker-compose.yml, docker-compose.caddy.yml, .env.example,
#         volumes/, dev/, utils/, ...
```

Note the commit hash so this deploy is reproducible:

```bash
git -C /tmp/sb rev-parse HEAD 2>/dev/null || \
  curl -s https://api.github.com/repos/supabase/supabase/commits/master | \
  python3 -c 'import sys,json; print(json.load(sys.stdin)["sha"])'
# Save this to ~/supabase-stack-sha.txt — it's the upstream pin for this install.
```

---

## 3. Clone TeamBrain

**Skip if already done** — `pr.fabric-testbed.net` already has `~/TeamBrain` checked out. If so, `git -C ~/TeamBrain pull --ff-only origin main` to update, then proceed to §4.

For a fresh deploy:

```bash
git clone https://github.com/mjstealey/TeamBrain ~/TeamBrain
cd ~/TeamBrain
git log -1 --oneline    # capture the TeamBrain commit hash too
```

**Treat the VM's TeamBrain checkout as read-only.** Never edit edge-function source or migrations on the VM directly — that creates drift between what's running and what main says. The flow is always: edit on your laptop → push to `origin/main` → `git pull` on the VM → re-sync into the running stack (see §8).

---

## 4. Layer in TeamBrain's production overrides

```bash
# Production override (TeamBrain env passthrough + Postgres 17 + kong loopback bind):
cp ~/TeamBrain/deploy/production/docker-compose.override.yml \
   ~/supabase-stack/docker-compose.override.yml

# Seed .env from upstream, then mint fresh secrets. `--update-env`
# rewrites `.env` in place; the `>/dev/null` redirect is **load-bearing**:
# without it the script echoes every freshly-minted secret to stdout,
# which then ends up in shell history, tmux scrollback, ssh-via-Claude
# transcripts, etc. Don't strip the redirect.
cd ~/supabase-stack
cp .env.example .env
bash utils/generate-keys.sh --update-env >/dev/null 2>&1
```

`generate-keys.sh` overwrites placeholder `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DASHBOARD_PASSWORD`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`, and a few others with cryptographically random values. **Save the generated `DASHBOARD_PASSWORD` to your password manager immediately** — you'll need it to access Studio.

> **Note — `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` stay blank.** Upstream's `.env.example` ships these two keys empty for the newer publishable/secret-key API system. `generate-keys.sh` doesn't populate them, and the load-bearing services at boot (Kong, GoTrue, PostgREST) only consume the classic `ANON_KEY` / `SERVICE_ROLE_KEY`. Leaving them blank is correct.

> **Quote the two Studio dashboard-label defaults.** Upstream ships `STUDIO_DEFAULT_ORGANIZATION=Default Organization` and `STUDIO_DEFAULT_PROJECT=Default Project` — values contain spaces with no quotes. Docker compose's env parser is fine with that, but any tool that `source`s `.env` (smoke-test scripts, deploy automation) hits `Organization: command not found` / `Project: command not found` because bash parses each as `KEY=Word` followed by a stray command word. One-liner fix:
> ```bash
> sed -i \
>   -e 's|^STUDIO_DEFAULT_ORGANIZATION=Default Organization$|STUDIO_DEFAULT_ORGANIZATION="Default Organization"|' \
>   -e 's|^STUDIO_DEFAULT_PROJECT=Default Project$|STUDIO_DEFAULT_PROJECT="Default Project"|' \
>   ~/supabase-stack/.env
> ```

Verify the secret block exists and is non-default:

```bash
grep -E '^(JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY)=' .env | \
  awk -F= '{printf "%s = <%d chars>\n", $1, length($0)-length($1)-1}'
# expect three lines, each value >32 chars
```

---

## 5. Configure `.env` (must-edit values)

Open `~/supabase-stack/.env` and set the values documented in `~/TeamBrain/deploy/production/env.template`. The short list:

| Key | Value | Source | Path |
|---|---|---|---|
| `PROXY_DOMAIN` | `pr.fabric-testbed.net` | DNS | A only (Caddy reads this) |
| `SUPABASE_PUBLIC_URL` | `https://pr.fabric-testbed.net` | derived | A + B |
| `API_EXTERNAL_URL` | `https://pr.fabric-testbed.net` | derived | A + B |
| `SITE_URL` | `https://pr.fabric-testbed.net` | derived | A + B |
| `CERTBOT_EMAIL` | a monitored email | Let's Encrypt registration | A only |
| `GITHUB_ENABLED` | `true` | required to switch GoTrue on | A + B |
| `GITHUB_CLIENT_ID` | from the production OAuth App | Prerequisites | A + B |
| `GITHUB_SECRET` | from the production OAuth App | Prerequisites | A + B |
| `OPENAI_API_KEY` | OpenAI key (production-billed preferred; personal acceptable at pilot scale) | Prerequisites | A + B |

> **Heads-up — the GitHub OAuth block ships commented out.** Upstream's `.env.example` has `GITHUB_ENABLED=false`, `GITHUB_CLIENT_ID=`, `GITHUB_SECRET=` all prefixed with `# `. After filling the values, you also have to **uncomment** the three lines and flip `GITHUB_ENABLED` to `true` — otherwise GoTrue starts without the provider and the OAuth round-trip 404s. An idempotent one-shot:
>
> ```bash
> sed -i \
>   -e 's/^[[:space:]]*#[[:space:]]*GITHUB_ENABLED=.*/GITHUB_ENABLED=true/' \
>   -e 's/^[[:space:]]*#[[:space:]]*GITHUB_CLIENT_ID=/GITHUB_CLIENT_ID=/' \
>   -e 's/^[[:space:]]*#[[:space:]]*GITHUB_SECRET=/GITHUB_SECRET=/' \
>   ~/supabase-stack/.env
> ```

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
grep -E '^(PROXY_DOMAIN|CERTBOT_EMAIL|GITHUB_CLIENT_ID|GITHUB_SECRET|OPENAI_API_KEY|TEAMBRAIN_GITHUB_)' ~/supabase-stack/.env | \
  awk -F= '{printf "%s = <%d chars>\n", $1, length($0)-length($1)-1}'
# expect 7+ lines, none with 0 chars
```

---

## 6. First boot

### Path A — Caddy

```bash
cd ~/supabase-stack

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
# Without an apikey, Kong's key-auth plugin returns 401 — that's the
# success signal that the gateway routed the request. To reach GoTrue:
set -a; source .env 2>/dev/null; set +a
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "apikey: $ANON_KEY" \
  https://pr.fabric-testbed.net/auth/v1/health
# expect: 200
```

### Path B — compose-managed nginx

The supabase stack comes up with the **`docker-compose.nginx.yml`** overlay (no caddy overlay). The overlay adds an `nginx` service that publishes `:80` + `:443`, terminates TLS with the institutional cert bind-mounted from `/root/cert/`, and reverse-proxies the public Supabase API paths to Kong over the docker network (`http://kong:8000`).

The server-block config lives in this repo at `deploy/production/nginx/conf.d/pr.fabric-testbed.net.conf` and is bind-mounted read-only into the container. Edit workflow: change the conf file in the repo → `git pull` on the box → `docker exec supabase-nginx nginx -t && docker exec supabase-nginx nginx -s reload`.

Two changes from upstream defaults keep every host-side port off `0.0.0.0` for everything that *isn't* the public nginx terminator:

1. **`.env` loopback-prefixes for host-bound ports.** Upstream's `.env.example` sets `KONG_HTTP_PORT=8000`, `KONG_HTTPS_PORT=8443`, `POOLER_PROXY_PORT_TRANSACTION=6543`. For Path B these need to be prefixed with `127.0.0.1:` so the base compose's `${KONG_HTTP_PORT}:8000/tcp` expression resolves to a loopback bind. **Do not prefix `POSTGRES_PORT`** — it's read by the db container as Postgres's internal listen port and must stay numeric (`5432`), or PG refuses to start with `FATAL: invalid value for parameter "port"`.
   ```bash
   sed -i \
     -e 's|^KONG_HTTP_PORT=8000$|KONG_HTTP_PORT=127.0.0.1:8000|' \
     -e 's|^KONG_HTTPS_PORT=8443$|KONG_HTTPS_PORT=127.0.0.1:8443|' \
     -e 's|^POOLER_PROXY_PORT_TRANSACTION=6543$|POOLER_PROXY_PORT_TRANSACTION=127.0.0.1:6543|' \
     ~/supabase-stack/.env
   ```
2. **supavisor's host port binding patched out of base** `~/supabase-stack/docker-compose.yml`. The pooler's session-mode bind on 5432 can't be loopback-prefixed via `.env` (POSTGRES_PORT collision with the db service), and every attempted override (`ports: !reset` / `!reset []` / `!override []` / `profiles: ["disabled"]`) was silently dropped by Compose v2.27.0 — `docker compose config --no-interpolate` kept showing the base's `${POSTGRES_PORT}:5432` regardless of override content; see [the override file](docker-compose.override.yml) for the full story. Last-resort workaround: delete the three lines directly from the base. This is a box-local edit, not a TeamBrain-repo change — re-apply if the upstream supabase docker subtree is re-cloned.
   ```bash
   cd ~/supabase-stack
   # Idempotent backup the first time, sed-delete after.
   [ -f docker-compose.yml.upstream-bak ] || cp docker-compose.yml docker-compose.yml.upstream-bak
   sed -i '/^  supavisor:$/,/^  [a-z]/ {
     /^    ports:$/d
     /^      - \${POSTGRES_PORT}:5432$/d
     /^      - \${POOLER_PROXY_PORT_TRANSACTION}:6543$/d
   }' docker-compose.yml
   ```
   The patch removes only the host-port bindings. supavisor still comes up and remains reachable from other containers over the docker network (service name `supavisor`); TeamBrain doesn't actually use it at pilot scale (PostgREST/GoTrue/Storage all reach `db` directly), so no host bind is the intended state.

For the bind-mount of `nginx/conf.d/` to resolve, `deploy/production/docker-compose.nginx.yml` uses a path relative to `~/supabase-stack/` — namely `../TeamBrain/deploy/production/nginx/conf.d`. That assumes `~/supabase-stack/` and `~/TeamBrain/` are siblings under the same user's home directory (matching the convention used elsewhere on the box). If your layout differs, change the bind source in `docker-compose.nginx.yml` accordingly.

Copy the two overlay files into `~/supabase-stack/` (or symlink them — either works, but copies make the deployed layout self-contained):

```bash
cp ~/TeamBrain/deploy/production/docker-compose.override.yml ~/supabase-stack/
cp ~/TeamBrain/deploy/production/docker-compose.nginx.yml    ~/supabase-stack/
```

Set `COMPOSE_FILE` in `~/supabase-stack/.env` so every subsequent `docker compose` command in this directory picks up both overlays implicitly — without it, plain `docker compose up -d` would silently drop nginx out of the stack:

```bash
sed -i.bak \
  -e '/^COMPOSE_FILE=/d' \
  ~/supabase-stack/.env
rm -f ~/supabase-stack/.env.bak
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.nginx.yml:docker-compose.override.yml' \
  >> ~/supabase-stack/.env
```

**Important — `COMPOSE_FILE` disables `override.yml` auto-discovery.** Compose normally auto-loads `docker-compose.override.yml` from the working directory, but **only when `COMPOSE_FILE` is unset**. Once `COMPOSE_FILE` is set, the list is authoritative and override.yml is no longer auto-discovered. The TeamBrain env passthrough (OPENAI_API_KEY, TEAMBRAIN_GITHUB_*, etc.) lives in override.yml, so missing it from the list silently strips those vars from the functions container. Path A deployments would set `COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml:docker-compose.override.yml`.

Verify the merge picked up the env block:

```bash
cd ~/supabase-stack
docker compose config | awk '/^  functions:/,/^  [a-z][a-z_]*:/' \
  | grep -E 'TEAMBRAIN_|EMBEDDING_|OPENAI_' | awk -F: '{print $1}' | sort -u
# expect: lines for TEAMBRAIN_DEFAULT_PROJECT_SLUG, TEAMBRAIN_GITHUB_APP_ID,
#         TEAMBRAIN_GITHUB_APP_PRIVATE_KEY, TEAMBRAIN_GITHUB_INSTALLATION_ID,
#         EMBEDDING_DIMS, EMBEDDING_PROVIDER, OPENAI_API_KEY,
#         OPENAI_EMBEDDING_MODEL
```

Bring up the full stack:

```bash
cd ~/supabase-stack

# COMPOSE_FILE in .env supplies the overlay list; override.yml auto-merges
# last and wins for any service-key conflict.
docker compose up -d
docker compose ps
# expect 13 services Healthy or Started (12 supabase services + nginx;
# no supavisor host bind, no caddy).

# Verify the loopback binds — kong on 127.0.0.1 only; nginx on 0.0.0.0:80
# and 0.0.0.0:443 is INTENDED (it's the public terminator); nothing else
# on 0.0.0.0; no supabase-pooler:
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E 'kong|nginx|pooler|0\.0\.0\.0'
# expect: kong with 127.0.0.1: prefixes, supabase-nginx with 0.0.0.0:80
#         + 0.0.0.0:443, no pooler row.
```

On-VM smoke (before going through the public terminator):

```bash
# Kong enforces the `key-auth` plugin on /auth/v1/* and /rest/v1/* — an
# unauthenticated request 401s. That's evidence the gateway is up and policy
# is active. To actually reach GoTrue/PostgREST, send the anon key:
set -a; source .env 2>/dev/null; set +a
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "apikey: $ANON_KEY" \
  http://127.0.0.1:8000/auth/v1/health
# expect: 200 — proves Kong + GoTrue are up on the loopback bind.
```

> **PGDATA is a host bind mount, not a docker named volume.** `volumes/db/data` lives on the VM filesystem and **survives `docker compose down -v`**. If you ever need a clean re-init (after a JWT_SECRET / POSTGRES_PASSWORD rotation, for example), you must `sudo rm -rf ~/supabase-stack/volumes/db/data/*` before the next `up -d` — otherwise PG sees "Database directory appears to contain a database; Skipping initialization" and comes up using the *old* password, leaving every service unable to authenticate.

The server block is already committed at `deploy/production/nginx/conf.d/pr.fabric-testbed.net.conf` and bind-mounted into the `supabase-nginx` container at `/etc/nginx/conf.d/` (read-only). No `docker cp` or in-image editing required — `docker compose ... up -d` above will have loaded it on first start.

If the cert filenames at `/root/cert/` differ from the FABRIC defaults baked into the committed conf, edit `deploy/production/nginx/conf.d/pr.fabric-testbed.net.conf` in the repo, `git pull` on the box, then reload:

```bash
docker exec supabase-nginx nginx -t        # syntax-check
docker exec supabase-nginx nginx -s reload # apply
```

The same reload flow applies to any subsequent server-block edits (location blocks, headers, etc.). The container's `/etc/nginx/conf.d/` is a bind-mount, so edits land immediately — only a reload is needed.

External smoke:

```bash
# From off-VM. Without an apikey expect 401 (Kong policy active); with
# the anon key expect 200. The HTTP/2 + subject/issuer probe verifies
# TLS termination via the institutional cert.
curl -sSv https://pr.fabric-testbed.net/auth/v1/health 2>&1 | grep -E '^< HTTP|subject:|issuer:'
# expect: HTTP/2 401, subject containing pr.fabric-testbed.net,
#         issuer matching your institutional CA.

# Then on-VM (anon key available there):
ssh fabric-pr 'sudo -iu nrig-service bash -lc "set -a; source ~/supabase-stack/.env 2>/dev/null; set +a; curl -sS -o /dev/null -w \"%{http_code}\\n\" -H \"apikey: \$ANON_KEY\" https://pr.fabric-testbed.net/auth/v1/health"'
# expect: 200
```

> **5432 reachability across the institutional firewall.** During this deploy we confirmed that `pr.fabric-testbed.net:5432` is **NOT** blocked at the network edge. The pooler override above (loopback bind via `!reset`) is therefore load-bearing, not just defense-in-depth — without it the supavisor session pool is publicly reachable for postgres-protocol auth attempts. Re-verify after any compose/firewall change: `bash -c '</dev/tcp/pr.fabric-testbed.net/5432' && echo OPEN || echo CLOSED`.

---

## 7. Apply Phase 1–2 migrations via Studio

Studio access depends on TLS path:

### Path A — Caddy basic-auth

Visit `https://pr.fabric-testbed.net` and authenticate with username `supabase` + the `DASHBOARD_PASSWORD` you saved in step 4. You should see Studio's project view.

### Path B — SSH tunnel to Kong

Studio is not publicly exposed. From your laptop:

```bash
ssh -L 3000:127.0.0.1:8000 nrig-service@pr.fabric-testbed.net
# leave that session open, then in your browser:
open http://localhost:3000
```

Kong's `/` route forwards to Studio internally, so the tunnel to Kong gives you Studio. No basic-auth is presented — the only access control is "you have SSH to the VM." When vouch-proxy + CILogon lands later, this gets replaced with a public `/studio/` location gated by `auth_request`.

### Both paths — apply migrations

In **SQL Editor → New query**, paste each migration's full contents from `~/TeamBrain/migrations/` and click **Run**. Apply in this order:

```
0001_init.sql
0002_rls.sql
0003_disable_graphql.sql
0004_match_thoughts.sql
[0005_resize_embedding_768.sql — only if running the ollama variant]
0006_embedding_model.sql
0007_projects_github_teams.sql
0008_project_members_soft_delete.sql
0009_sync_runs.sql
0010_pg_cron_membership_sync.sql
0011_project_registration.sql
```

`0011_project_registration.sql` (Phase 4) drops the placeholder `projects_insert_authenticated` policy so the only path to create a project is the gated `teambrain-register-project` function (§8). Apply it together with the batch above.

After each, run the verification queries from `docs/phase-1-checklist.md` § B/C/D/E and `docs/phase-2-checklist.md` § B/L as a check. Expect Studio's **Security Advisor: 0 errors / 0 warnings** and **Performance Advisor: 0 issues** after `0003`. If anything else is red, stop and triage.

---

## 8. Deploy the edge functions

The VM's `~/TeamBrain` checkout (per §3) is the source. Pull-then-copy keeps the running stack in lockstep with `main` — and because §3 mandates the VM checkout is read-only, the laptop checkout and the VM checkout are always identical at a given SHA.

On the VM (as `nrig-service`):

```bash
# 1. Sync the VM's TeamBrain checkout to latest main.
git -C ~/TeamBrain pull --ff-only origin main
git -C ~/TeamBrain log -1 --oneline    # record the SHA being deployed

# 2. Copy each edge function into the supabase-stack volumes/functions/ tree.
#    rsync --delete keeps the destination tree exactly matching source
#    (removes files that have been deleted upstream).
for fn in teambrain-mcp teambrain-membership-sync teambrain-register-project \
          teambrain-rest teambrain-token teambrain-summarize \
          teambrain-staleness teambrain-slack; do
  rsync -av --delete \
    ~/TeamBrain/edge-functions/"$fn"/ \
    ~/supabase-stack/volumes/functions/"$fn"/
done

# 3. Recreate the functions container so it sees the new dirs.
cd ~/supabase-stack
docker compose up -d --force-recreate functions
docker compose logs functions --tail 30
```

If you'd rather push *from your laptop* (e.g., to deploy an in-flight branch without pushing to `origin` first), the alternative is rsync-with-sudo via the SSH alias:

```bash
# From your laptop. Substitutes for steps 1–2 above.
for fn in teambrain-mcp teambrain-membership-sync teambrain-register-project \
          teambrain-rest teambrain-token teambrain-summarize \
          teambrain-staleness teambrain-slack; do
  rsync -av --delete \
    --rsync-path='sudo -u nrig-service rsync' \
    ~/GitHub/mjstealey/TeamBrain/edge-functions/"$fn"/ \
    fabric-pr:/home/nrig-service/supabase-stack/volumes/functions/"$fn"/
done
# Then on the VM: cd ~/supabase-stack && docker compose up -d --force-recreate functions
```

(Absolute path on the right side of the `:` is required — `~` would expand to the SSH-login user's home, not `nrig-service`'s.)

> **Note.** Two functions import from siblings via relative paths, so the import only resolves when both are deployed under the same `volumes/functions/` root (the loops above do this): `teambrain-register-project` imports the GitHub-App token mint + per-project sync from `teambrain-membership-sync`, and `teambrain-rest` imports `embedding.ts` from `teambrain-mcp`. Removing or renaming `teambrain-membership-sync` breaks registration; removing or renaming `teambrain-mcp` breaks the REST capture/search endpoints.

Verify the functions container picked up the TeamBrain env vars:

```bash
docker compose exec functions env | grep -E '^(EMBEDDING_|OPENAI_|TEAMBRAIN_)' | \
  awk -F= '{printf "%s = <%d chars>\n", $1, length($0)-length($1)-1}'
# expect: EMBEDDING_PROVIDER, EMBEDDING_DIMS, OPENAI_API_KEY,
#         OPENAI_EMBEDDING_MODEL, TEAMBRAIN_DEFAULT_PROJECT_SLUG,
#         TEAMBRAIN_GITHUB_APP_ID, TEAMBRAIN_GITHUB_INSTALLATION_ID,
#         TEAMBRAIN_GITHUB_APP_PRIVATE_KEY (>1500 chars for PEM),
#         TEAMBRAIN_GITHUB_ORG
```

---

## 9. MCP smoke test (Phase 2)

```bash
ANON_KEY=$(grep '^ANON_KEY=' ~/supabase-stack/.env | cut -d= -f2)

curl -sS -X POST \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://pr.fabric-testbed.net/functions/v1/teambrain-mcp/mcp
# expect: an SSE `event: message` / `data: { ... }` response whose
# data payload is a JSON-RPC envelope listing six tools (ping,
# capture_project_thought, search_project_thoughts,
# list_recent_project_thoughts, mark_stale, promote_to_docs).
```

The `Accept: application/json, text/event-stream` header is mandated by the MCP HTTP transport spec — omitting it returns `Not Acceptable: Client must accept both application/json and text/event-stream`. The response comes back as a single SSE message (one `event: message` / `data: ...` block followed by EOF) rather than plain JSON.

The MCP function rejects requests authenticated only by the anon key for any tool that touches RLS-scoped data — that's expected. The `tools/list` method is auth-light.

For an end-to-end RLS smoke test, sign in once via the web at `https://pr.fabric-testbed.net/auth/v1/authorize?provider=github`. The landing page renders your user JWT plus a ready-to-paste `claude mcp add` command pre-filled for this deployment — copy + run on your laptop, then restart Claude Code and verify the `teambrain` server appears in `/mcp`. See `docs/phase-2-checklist.md` § H for the full curl matrix and for direct CLI client wiring without the landing-page convenience.

> **`claude mcp add` flag-order gotcha.** When wiring TeamBrain into Claude Code by hand, put the positional arguments (`<name>` and `<url>`) **before** any `-H/--header` flags. The `--header` option is variadic (`<header...>`), so any positionals appearing after it are greedily consumed as additional header values, and you'll get `error: missing required argument 'name'`. The landing page's pre-filled command is already correctly ordered.

---

## 10. Set the project's GitHub team slug

> **Note.** Phase 3 migrations (`0007_projects_github_teams.sql`, `0008_project_members_soft_delete.sql`, `0009_sync_runs.sql`, `0010_pg_cron_membership_sync.sql`) and `seed.sql` are part of the consolidated §7 batch (`migrations/0001`-`migrations/0010`). If you applied §7 in order they are already in place — no separate Phase 3 application step is needed.

The remaining one-time configuration step is to tell the sync function which GitHub team membership should imply the `admin` role. Apply against the running stack as `supabase_admin`:

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres <<'SQL'
update public.projects
set github_team_slugs = array['systemservicesteam']
where repo_slug = 'fabric-testbed/fabric-core-api';
SQL
```

Or paste the inner `update` into Studio SQL Editor (over the SSH tunnel per §7) if you prefer a UI. Verify:

```sql
select repo_slug, github_team_slugs from public.projects;
-- expect: ('fabric-testbed/fabric-core-api', '{systemservicesteam}')
```

If `github_team_slugs` is left empty (`{}`), the sync function falls back to the broadest `affiliation=all` collaborator query — every repo collaborator becomes `contributor` and nobody gets `admin` automatically. That is rarely what you want.

---

## 11. Phase 3 smoke test (on-demand sync)

```bash
SERVICE_KEY=$(grep '^SERVICE_ROLE_KEY=' ~/supabase-stack/.env | cut -d= -f2)

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

The `127.0.0.1:8000` bind on Kong is for on-VM-only testing. The same call works through the public hostname on both TLS paths — basic-auth only fronts Studio in Path A; `/functions/v1/*` is unauthenticated at the proxy layer in both paths (the function itself enforces JWT role):

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

## 11a. Self-service project registration (Phase 4)

`teambrain-register-project` lets any **org member who is an admin of a GitHub repo** register that repo as a TeamBrain project — no manual `INSERT` / seed by an operator. The function (running as service_role) verifies the caller's repo-admin permission via the GitHub App, inserts the `projects` row, seeds the caller as `admin`, and runs the membership sync to pull in the rest of the team.

Unlike the membership-sync endpoints (service-role-only), this one requires a **GitHub-OAuth user JWT** (`role: authenticated`) — get one by signing in at `https://pr.fabric-testbed.net/` and copying the access token from the landing page.

```bash
USER_JWT='<paste the access_token from the landing page>'
ANON_KEY=$(grep '^ANON_KEY=' ~/supabase-stack/.env | cut -d= -f2)

curl -sS -X POST \
  -H "Authorization: Bearer $USER_JWT" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"repo_slug":"fabric-testbed/some-repo","github_team_slugs":[]}' \
  https://pr.fabric-testbed.net/functions/v1/teambrain-register-project/register \
  | python3 -m json.tool
# expect 201: { "project": { id, repo_slug, name, ... },
#               "sync":    { added: [...], skipped_no_auth_row: [...] } }
```

Expected rejections (all surface a JSON `{ "error": ... }`):

| Status | Cause |
| --- | --- |
| `400` | `repo_slug` missing or not `owner/repo` form |
| `403` | repo owner ≠ `TEAMBRAIN_GITHUB_ORG` (org gate) |
| `403` | caller's effective repo permission is not `admin` |
| `403` | caller's account has no GitHub identity (`user_metadata.user_name` absent) |
| `404` | repo not found, or the TeamBrain GitHub App is not installed on it |
| `409` | `repo_slug` already registered |

`name` defaults to the `repo_slug` if omitted. `github_team_slugs` follows the same C-plus membership semantics as §10 — empty means "all collaborators"; non-empty gates membership on team-or-direct-grant.

---

## 11b. REST surface (Phase 4)

`teambrain-rest` is a plain HTTP/JSON mirror of the MCP tools, for clients that aren't MCP-native (curl, OpenAI/gemini function calling, GitHub Actions, CI). Same backend, same RLS, same GitHub-OAuth JWT — every request builds a per-request `userClient` (ANON_KEY + forwarded `Authorization`), so `auth.uid()` does all access control. It reuses `embedding.ts` from `teambrain-mcp` (deploy both together — see the §8 note) and needs **no new env vars** (it reuses `EMBEDDING_*`, `OPENAI_*`, `TEAMBRAIN_DEFAULT_PROJECT_SLUG`).

The published contract is the **OpenAPI 3.1 spec served at `https://pr.fabric-testbed.net/openapi.yaml`** (static file from `deploy/production/nginx/html/openapi.yaml`, fronted by the nginx `location = /openapi.yaml`). Endpoints, all under `/functions/v1/teambrain-rest`:

| Method + path | Mirrors MCP tool |
| --- | --- |
| `GET /health` | `ping` |
| `POST /thoughts` | `capture_project_thought` |
| `POST /thoughts/search` | `search_project_thoughts` |
| `GET /thoughts` | `list_recent_project_thoughts` |
| `PATCH /thoughts/{id}/stale` | `mark_stale` |
| `POST /thoughts/{id}/promote` | `promote_to_docs` |

Smoke test (needs a **user** JWT from the landing page, not the service key — `/functions/*` authenticates on the bearer alone, no `apikey` required):

```bash
USER_JWT='<access_token from https://pr.fabric-testbed.net/>'
BASE=https://pr.fabric-testbed.net/functions/v1
H=(-H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json")

curl -sS "${H[@]}" "$BASE/teambrain-rest/health" | python3 -m json.tool
# expect: {service:"teambrain-rest", uid, visible_thought_rows, ...}

# capture → search round-trip:
ID=$(curl -sS "${H[@]}" -X POST "$BASE/teambrain-rest/thoughts" \
  -d '{"content":"REST smoke — safe to delete.","scope":"project","type":"context","project_slug":"fabric-testbed/TeamBrain","tags":["smoke"]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -sS "${H[@]}" -X POST "$BASE/teambrain-rest/thoughts/search" \
  -d '{"query":"REST smoke","project_slug":"fabric-testbed/TeamBrain"}' | python3 -m json.tool
curl -sS "${H[@]}" -X PATCH "$BASE/teambrain-rest/thoughts/$ID/stale" -d '{}' | python3 -m json.tool
```

Per-endpoint recipes, an OpenAI function-calling client, and an (illustrative) GitHub Actions capture-on-merge workflow live under `examples/` in the repo.

---

## 11c. Slack surface (Phase 5 § B)

`teambrain-slack` exposes a `/tb` slash command (`remember` / `recall` / `recent` / `status` / `link` / `help`) scoped per Slack channel to a TeamBrain project. Slack-app creation and channel linking are walked through in `examples/slack/README.md`; this section is the **server-side** deploy.

Components touched (all in this repo):

| Piece | What changes |
| --- | --- |
| `migrations/0023_slack_channels.sql` | channel → project mapping table (service_role-only) |
| `edge-functions/teambrain-slack/` | the function (§8 rsync loop already includes it) |
| `docker-compose.override.yml` | `SLACK_SIGNING_SECRET` + `SUPABASE_PUBLIC_URL` passthrough |
| `nginx/templates/pr.fabric-testbed.net.conf.template` | anon-key injection on `/functions/v1/teambrain-slack/slack/` (Slack can't send an `Authorization` header; the dispatcher's `VERIFY_JWT` gate needs one — the real auth is the Slack HMAC signature checked inside the function) |

Deploy order:

```bash
# 0. Apply migrations/0023_slack_channels.sql via Studio (§7 workflow).

# 1. .env on the VM: add the signing secret from the Slack app's
#    Basic Information page (see examples/slack/README.md step 1).
#    SLACK_SIGNING_SECRET=...

# 2. Re-copy the override (copy, not symlink!), then recreate the
#    affected services. The nginx template needs no copy — the Path-B
#    overlay bind-mounts it straight from the ~/TeamBrain checkout, so
#    the §8 `git pull` already updated it; recreating nginx re-runs the
#    envsubst step.
cp ~/TeamBrain/deploy/production/docker-compose.override.yml ~/supabase-stack/
cd ~/supabase-stack
docker compose up -d --force-recreate functions nginx

# 3. rsync the function per §8 (the loop already lists teambrain-slack).
```

Smoke, before any Slack app exists (proves routing + signature gate):

```bash
ANON_KEY=$(grep '^ANON_KEY=' ~/supabase-stack/.env | cut -d= -f2)

# Health: slack_command_enabled flips to true once the secret is set.
curl -sS -H "Authorization: Bearer $ANON_KEY" \
  https://pr.fabric-testbed.net/functions/v1/teambrain-slack/health | python3 -m json.tool

# Unsigned POST must be rejected 401 (signature gate) — note NO
# Authorization header here: nginx injects the anon key on this path.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'command=/tb&text=help' \
  https://pr.fabric-testbed.net/functions/v1/teambrain-slack/slack/command
# expect: 401
```

A correctly **signed** synthetic request (full pre-Slack smoke — computes the
v0 HMAC the way Slack does):

```bash
SLACK_SIGNING_SECRET='<value from .env>' python3 - <<'PY'
import hashlib, hmac, os, time, urllib.request
secret = os.environ['SLACK_SIGNING_SECRET'].encode()
body   = 'command=/tb&text=help&team_id=T00000000&channel_id=C00000000&user_name=smoke&response_url=https://example.invalid/x'
ts     = str(int(time.time()))
sig    = 'v0=' + hmac.new(secret, f'v0:{ts}:{body}'.encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(
    'https://pr.fabric-testbed.net/functions/v1/teambrain-slack/slack/command',
    data=body.encode(), method='POST',
    headers={'Content-Type': 'application/x-www-form-urlencoded',
             'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig})
print(urllib.request.urlopen(req).read().decode())
PY
# expect: 200 with the ephemeral /tb help text as JSON
```

Then finish the Slack-side setup (app from manifest, channel link, in-Slack `/tb` smoke) per `examples/slack/README.md`.

---

## 12. Schedule the recurring sync (pg_cron) + health monitoring

The sync cron reads its target URL and service-role bearer from
`public.app_config` (migration **0013**) — a durable table that survives the
`pg_db_role_setting` reset that silently broke the sync for ~2 days in 2026-05.
Migration 0010 originally read these from per-database GUCs; **0013 supersedes
that** and reschedules the cron to read the table.

Apply both migrations:

```
0010_pg_cron_membership_sync.sql      # creates the */15 schedule
0013_sync_health_monitoring.sql       # app_config + reschedule + */30 healthcheck
```

0013 seeds the non-secret URL row itself. Seed the **secret** service-role key
row once (Studio SQL Editor, run as supabase_admin):

```sql
insert into public.app_config (key, value)
values ('teambrain_service_role_key', '<paste SERVICE_ROLE_KEY value from .env>')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

> **If the sync ever goes silent again, check this first:**
> `select key, length(value) from public.app_config;` — a missing row is the
> 2026-05 root cause. (The old `app.teambrain_*` GUCs, if previously set, are
> now unused and can be left in place.)

Verify the schedules:

```sql
select jobname, schedule from cron.job
where jobname in ('teambrain-membership-sync', 'teambrain-sync-healthcheck');
-- expect 2 rows: '*/15 * * * *' and '*/30 * * * *'
```

Wait ~15 minutes past a quarter-hour boundary, then:

```sql
-- Did the sync function process it?
select started_at, project_id is null as is_aggregate, ok, error
from public.sync_runs
order by started_at desc limit 5;
-- expect: rows landing every 15 min; latest is an aggregate (project_id IS NULL)

-- Is the health classifier green, and the exception log empty?
select * from public.membership_sync_health();   -- expect status = 'ok'
select count(*) from public.health_events;        -- expect 0 in steady state
```

### Health endpoint (external uptime monitoring)

`GET /functions/v1/teambrain-membership-sync/health` returns **200** when the
sync is healthy and **503** when it is stale/failing — point an uptime monitor
(UptimeRobot, a cron+curl, …) at it. It needs only the public anon key (it
clears the gateway with any valid JWT; the payload is non-sensitive — status,
timestamps, a failure count, and whether the `app_config` rows exist):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${ANON_KEY}" \
  "https://pr.fabric-testbed.net/functions/v1/teambrain-membership-sync/health"
# 200 healthy · 503 stale/failing
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
# Example backup script (place in ~/backups/backup-supabase.sh, run via systemd timer):
#!/bin/bash
set -euo pipefail
DEST=~/backups/$(date +%Y-%m-%d).sql.gz
docker compose -f ~/supabase-stack/docker-compose.yml exec -T db \
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
3. Update `TEAMBRAIN_GITHUB_APP_PRIVATE_KEY` in `~/supabase-stack/.env`.
4. `cd ~/supabase-stack && docker compose up -d --force-recreate functions`.
5. Trigger an on-demand `/sync` — verify a 200 with a real diff/report.
6. Revoke the old key from the App settings.

If the new key fails, the old key still works during step 4 since key revocation is decoupled from key rotation. Always validate before revoking.

### Security Advisor verification (lints 0008 / 0028 / 0029)

Run after applying the advisor-paydown migrations (`0015`, `0016`) or after any fresh deploy, to confirm the `service_role`-only lockdown of `public.api_tokens` / `public.app_config` (RLS-enabled, deny-all policy) and `public.membership_sync_health()`. All read-only — paste into Studio SQL Editor (over the SSH tunnel, §7) as `supabase_admin`:

```sql
-- 1. Deny-all policies exist on the two service_role-only tables (lint 0008).
select tablename, policyname, permissive, roles, qual, with_check
from pg_policies
where tablename in ('api_tokens', 'app_config')
order by tablename;
-- expect 2 rows: *_no_direct_access · PERMISSIVE · {public} · qual=false · with_check=false

-- 2. RLS still enabled on both.
select relname, relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and relname in ('api_tokens', 'app_config');
-- expect rls_enabled = true for both

-- 3. No anon/authenticated table grants. (service_role holding *all* privileges
--    — incl. TRUNCATE/REFERENCES, via the 0001 baseline GRANT ALL — is expected
--    and fine; the security-relevant fact is the absence of the API-facing roles.)
select table_name, grantee
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('api_tokens', 'app_config')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee;
-- expect: zero rows

-- 4. membership_sync_health() not executable by the API-facing roles (lints
--    0028/0029). postgres + supabase_admin retaining EXECUTE is expected —
--    owner/superuser roles, unreachable through the PostgREST JWT surface.
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name   = 'membership_sync_health'
  and grantee in ('anon', 'authenticated', 'PUBLIC');
-- expect: zero rows
```

Then open Studio's **Security Advisor** — it should report **0 errors / 0 warnings / 0 info** for these tables/function (lints 0008, 0028, 0029 all gone). Finally, confirm the lockdown didn't disturb the `service_role` read path the edge functions depend on:

```bash
set -a; source ~/supabase-stack/.env 2>/dev/null; set +a
curl -sS --max-time 20 -H "Authorization: Bearer $ANON_KEY" \
  https://pr.fabric-testbed.net/functions/v1/teambrain-membership-sync/health | python3 -m json.tool
# expect: status="ok", config.sync_url_set=true, config.service_role_key_set=true
# — the live proof that service_role still reads app_config through the deny-all
#   policy (the policy applies only to anon/authenticated; service_role bypasses RLS).
```

---

## Troubleshooting

### (Path A) Caddy keeps restarting / no cert obtained

- Check `docker compose logs caddy --tail 100`.
- `dig +short pr.fabric-testbed.net` — must return the VM IP from an *external* host. ACME challenge originates from Let's Encrypt's servers, not from inside the VM.
- Firewall: `nc -zv pr.fabric-testbed.net 80` from outside the VM must succeed.
- Rate limit: Let's Encrypt allows 5 cert attempts per hostname per week. If you've been retrying, wait or use `--staging` via the `LEGO_CA_SYSTEM_CERT_POOL` / `CADDY_ACME_CA` envs (consult upstream caddy overlay docs).

### (Path B) nginx returns 502 Bad Gateway

- Kong is not resolving on the docker network. From inside the nginx container: `docker exec supabase-nginx getent hosts kong` — expect a row with kong's container IP. If absent, the `supabase-nginx` and `supabase-kong` containers aren't on the same compose network; re-bring the stack up with both overlays explicit (`-f docker-compose.yml -f docker-compose.nginx.yml`).
- Kong is unhealthy. `docker compose ps kong` should show `(healthy)`. If not, check `docker logs supabase-kong` — most often a missing env var (`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `KONG_DECLARATIVE_CONFIG`).

### (Path B) Browser shows TLS error / wrong certificate

- The server block isn't loaded inside the container. `docker exec supabase-nginx nginx -T | grep -E 'server_name|ssl_certificate'` — confirm both `pr.fabric-testbed.net` and the cert path under `/etc/nginx/cert/` appear. If they don't, the bind-mount source path in `docker-compose.nginx.yml` (`../TeamBrain/deploy/production/nginx/conf.d`) doesn't resolve to a real directory on the box — confirm the `~/supabase-stack/` + `~/TeamBrain/` sibling layout, or edit the overlay's bind source.
- The cert doesn't cover this hostname. `openssl s_client -connect pr.fabric-testbed.net:443 -servername pr.fabric-testbed.net </dev/null 2>/dev/null | openssl x509 -noout -text | grep -A1 'Subject Alternative Name'` — the SAN list must include `pr.fabric-testbed.net` (or a wildcard that does).

### (Path B) `docker exec supabase-nginx nginx -s reload` exits non-zero

- Run `docker exec supabase-nginx nginx -t` for the actual syntax error. Common causes: copy-paste smart-quotes in the conf file; cert/key path typo (cert lives at `/etc/nginx/cert/` inside the container, not `/etc/letsencrypt/`); duplicate `server_name` clashing with the stock `default.conf`. If the stock default conflicts, the cleanest fix is to mount over it — add a second bind that maps an empty file (or a file with `server_name _;`) to `/etc/nginx/conf.d/default.conf` in `docker-compose.nginx.yml`.

### (Path B) nginx container won't start, "bind: address already in use"

- Something else on the VM is already holding `:80` or `:443`. `ss -tlnp '( sport = :80 or sport = :443 )'` — expect no rows before the stack is up. A common culprit on `pr.fabric-testbed.net` historically was a placeholder host-side nginx container; remove any such container (`docker rm -f <name>`) before bringing the stack up.

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

- The function's source isn't actually present at `~/supabase-stack/volumes/functions/<name>/`. Re-rsync from your laptop and `docker compose restart functions`.

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
| Edge-function source | `edge-functions/{teambrain-mcp,teambrain-membership-sync,teambrain-register-project,teambrain-rest}/` |
| OpenAPI spec (served at `/openapi.yaml`) | `deploy/production/nginx/html/openapi.yaml` |
| REST/OpenAPI example clients | `examples/{curl.md,openai_function_calling.py,github-actions/}` |
| Migrations | `migrations/` (README inside the dir) |
