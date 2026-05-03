# Phase 0 Checklist

Concrete, ordered tasks to complete before Phase 1 (multi-tenant schema + RLS) begins. Each item has an explicit **Done when** acceptance criterion.

Phase 0 stands up everything needed for Phase 1 to land safely: a working scratch Supabase instance, a working GitHub OAuth round-trip, the pilot repo decision, and a clean git history.

---

## A — Repo housekeeping (status: complete)

### A1. Symlink cleanup ✅

`team-brain → TeamBrain` symlink removed. Working dir is `~/GitHub/mjstealey/TeamBrain/`.

### A2. License chosen: Apache-2.0 ✅

`LICENSE` (Apache 2.0 with 2026 copyright) committed at repo root; `README.md` license section names it. Patent grant + permissive terms — appropriate for research/infrastructure and keeps commercial-derivative options open (the original reason for going parallel-repo over forking OB1's FSL-1.1-MIT).

### A3. Git initialized + initial commit ✅

```
git init
git branch -m main           # rename master → main
# stage + commit handled manually by user
```

Default branch is `main`. Initial commit covers `CLAUDE.md`, `README.md`, `CREDITS.md`, `LICENSE`, `.gitignore`, `docs/` (incl. `docs/adr/0001-teambrain-architecture.md`, `docs/deployment.md`, this file). `.claude/settings.local.json` correctly excluded by `.gitignore`.

All commits are GPG-signed (global `commit.gpgsign=true`).

### A4. Remotes configured ✅

Two named remotes per the "two named remotes" pattern (each independent; explicit push target per remote — no surprise mirroring):

| Remote | URL | Role |
|---|---|---|
| `origin` | `git@github.com:fabric-testbed/TeamBrain.git` | **Canonical** (private, org-owned — survives developer turnover) |
| `personal` | `git@github.com:mjstealey/TeamBrain.git` | Personal mirror / WIP push target |

Current branch tracks `personal/main`. To also push to the canonical org remote: `git push origin main` (one-time `-u origin main` if you want to switch the tracking branch).

### A5. Stage and commit Section A doc updates (next action)

Three doc edits sit unstaged in the working tree from Section A → B decision-capture work:

- `CLAUDE.md` — added "Local Reference Forks" section (OB1 + supabase forks at `~/github/mjstealey/`); promoted pilot-repo decision (`fabric-core-api`) into Settled Decisions; cleared Open Decisions.
- `docs/deployment.md` — Stack section now points at the local supabase fork as the canonical source for `docker/` artifacts.
- `docs/phase-0-checklist.md` — D1 rewritten to copy from the local fork; B1 rewritten as "Pilot reviewer buy-in" with five sub-questions for Komal Thareja; Section A rewritten as "status: complete".

Suggested commit (run manually — git operations stay user-driven per the A3 convention):

```bash
git add CLAUDE.md docs/deployment.md docs/phase-0-checklist.md
git commit -m "Phase 0: capture pilot decision (fabric-core-api), local reference forks, Section A status"
git push personal main
git push origin main           # only if you also want the canonical org remote updated now
```

**Done when:** `git status` is clean; the chosen remote(s) reflect the new commit.

---

## B — Pilot reviewer buy-in (can run in parallel with C and D)

### B1. Confirm Komal Thareja's participation in the fabric-core-api pilot

Pilot repo decided 2026-05-03: **`~/github/fabric/fabric-core-api`** (remote `fabric-testbed/fabric-core-api`). Refactoring will be done solo by Michael with Claude Code; Komal is the primary reviewer. The team-coordination signal being tested is multi-developer **commentary** on a single committer's changes, not multi-committer coordination. (Workflow-monitor remains an optional Phase 2 plumbing pilot before graduating to fabric-core-api for Phase 7.)

Sub-questions to ask Komal (covers social coordination + compliance + reviewer-pool sizing — the four things that can still derail the pilot now that the repo is chosen):

1. **OAuth login willingness.** Are you willing to sign in once with GitHub OAuth at `https://pr.fabric-testbed.net` so I can hand-seed your `project_members` row for the pilot? It's the same GitHub account you already use to push to `fabric-testbed/fabric-core-api`; no new credential.
2. **Review cadence during the pilot window.** Roughly how many fabric-core-api PRs do you expect to review per week over the next 4–6 weeks (the pilot evaluation window), and at what depth — quick approvals, or substantive line-level commentary? The pilot's value test depends on review *commentary* volume, not just approvals, so a rough number helps me calibrate whether the dataset will be statistically meaningful.
3. **Compliance / org concerns.** Any objections from FABRIC ops or compliance to a self-hosted Supabase on `pr.fabric-testbed.net` (FABRIC team-owned VM, GitHub OAuth, no third-party AI vendors in the data path) holding code-adjacent notes — review comments, debugging gotchas, decision rationale tied to fabric-core-api PRs/commits? Studio admin UI is gated behind vouch-proxy + CILogon (reuses our existing pattern); app-level auth is GitHub OAuth.
4. **Other reviewers worth inviting.** Anyone else on the FABRIC side who reviews fabric-core-api PRs regularly (or who *should*) and would benefit from being seeded as a `project_members` row at pilot start? Larger reviewer pool = stronger signal on the "we already discussed this" miss-rate metric.
5. **AGENTS.md surface.** Would you be willing to read a single `AGENTS.md` file at the repo root once before the pilot starts? It's the contract that tells Claude (and any other AI tool any reviewer uses) how to query / capture against TeamBrain. No ongoing reading burden — just the one-time orientation.

Optional follow-ups if Komal agrees:
- Any existing tribal knowledge about fabric-core-api that should be **seeded as initial memories** before the pilot opens (so Claude has the v1.9 → v1.10 migration context, COU semantics, role-removal history loaded from day one rather than discovering it via repeated reviewer corrections)?
- Preferred review-comment format for capture-friendliness — does she want to keep commenting in GitHub PR threads as usual (TeamBrain pulls them via webhook in Phase 5), or is she open to a `/capture` slash command in her AI tool of choice?

**Done when:** Komal answers questions 1–5; if any answer is "no", revisit (workflow-monitor as Phase 2 plumbing pilot is the obvious fallback). Update this checklist with the answers and capture them as a follow-up `PROJECT: TeamBrain — ` thought in Open Brain.

---

## C — GitHub OAuth Apps (status: complete)

### C1. Two OAuth apps registered ✅

Two separate apps (intentional — different secrets, isolated rotation, scratch-secret leak doesn't touch prod):

| App | Where | Homepage | Callback URL |
|-----|-------|----------|--------------|
| `TeamBrain` | `fabric-testbed` org | `https://pr.fabric-testbed.net` | `https://pr.fabric-testbed.net/auth/v1/callback` |
| `TeamBrain-scratch` | (scratch — owner TBD; personal account is fine since secret is dev-only) | `https://127.0.0.1:8443` | `https://127.0.0.1:8443/auth/v1/callback` |

Note the scratch host is `127.0.0.1`, not `localhost`. GitHub does exact-string matching on callback URLs — keep this consistent everywhere downstream (Nginx `server_name`, `SITE_URL`, `API_EXTERNAL_URL`, the harness page's origin). Mixing `localhost` and `127.0.0.1` in any of those will fail OAuth even though they resolve to the same address.

Client IDs + Client Secrets stored in password manager. Not in this repo, not in any committed file.

### C2. Minimum scopes for membership sync

Phase 3 sync needs at minimum: `read:user`, `user:email`, `read:org`. Add `repo` only if the pilot repo is private (`public_repo` or no repo scope is enough for public repos). fabric-core-api is a public org repo — the minimum set is sufficient.

---

## D — Scratch Supabase instance (Nginx + mkcert HTTPS on `https://127.0.0.1:8443`; ~60–75 min)

Do **not** touch `pr.fabric-testbed.net` until everything in this section passes.

**Topology:** browser → Nginx (TLS termination on `:8443`, mkcert local-CA cert) → Kong (`127.0.0.1:8000`) → GoTrue/PostgREST/Storage/Edge Runtime/etc. Studio is also fronted by Nginx (or accessed directly on `127.0.0.1:3000` for admin tasks). This mirrors the production topology (`pr.fabric-testbed.net` → Caddy → Kong) so issues found here translate directly.

### D1. Stage the supabase docker stack from the local fork

The fork at `~/github/mjstealey/supabase/` is read-only reference. Copy the `docker/` subtree to a scratch working dir, then template the `.env`:

```bash
gh repo sync mjstealey/supabase
cp -R ~/github/mjstealey/supabase/docker ~/scratch/supabase-stack   # any path outside TeamBrain works
cd ~/scratch/supabase-stack
cp .env.example .env
```

**Done when:** the fork is synced, `~/scratch/supabase-stack/.env` exists, and the original fork directory is unmodified (`cd ~/github/mjstealey/supabase && git status` is clean).

### D2. Provision a trusted local cert with mkcert

`mkcert` installs a local CA into the system trust store, then issues "self-signed" certs that browsers and `curl` already trust — no per-request bypass, no pinned-cert dance.

```bash
brew install mkcert nss             # nss only needed if you use Firefox
mkcert -install                     # one-time: registers the local CA
mkdir -p ~/scratch/tls && cd ~/scratch/tls
mkcert 127.0.0.1 localhost ::1      # produces 127.0.0.1+2.pem and 127.0.0.1+2-key.pem
```

**Done when:** `~/scratch/tls/127.0.0.1+2.pem` and `127.0.0.1+2-key.pem` exist; `curl https://127.0.0.1:8443/` (after D4) returns no certificate errors.

### D3. Configure the scratch `.env` (in `~/scratch/supabase-stack/.env`)

The supabase `.env` lives in the scratch working dir, outside any source control. Do **not** copy it (or any of its values) into the TeamBrain repo.

The supabase fork ships two scripts that handle the secret rotation for you — much safer than manual openssl + jwt.io because they sign the legacy HS256 JWTs and generate the new ES256 keypairs in one shot:

```bash
cd ~/scratch/supabase-stack

# Rotates: POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY,
# SECRET_KEY_BASE, VAULT_ENC_KEY, PG_META_CRYPTO_KEY,
# LOGFLARE_PUBLIC/PRIVATE_ACCESS_TOKEN, MINIO_ROOT_PASSWORD, DASHBOARD_PASSWORD.
# Redirect stdout to /dev/null — the script prints generated secrets there too.
sh ./utils/generate-keys.sh --update-env >/dev/null

# Generates: JWT_KEYS (EC private), JWT_JWKS (EC public), SUPABASE_PUBLISHABLE_KEY,
# SUPABASE_SECRET_KEY (opaque API keys). Requires node >= 16 and a JWT_SECRET in .env
# (generate-keys.sh sets that, hence the order).
sh ./utils/add-new-auth-keys.sh --update-env >/dev/null
```

Then set the URL fields and the GitHub OAuth fields with `sed -i` (or a text editor — but `sed` keeps the secrets out of the conversation/transcript). Use the values from the password-manager entry for `TeamBrain-scratch` for `GITHUB_CLIENT_ID` / `GITHUB_SECRET`:

```bash
cd ~/scratch/supabase-stack
sed -i.bak \
  -e 's|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=https://127.0.0.1:8443|' \
  -e 's|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=https://127.0.0.1:8443|' \
  -e 's|^SITE_URL=.*|SITE_URL=https://127.0.0.1:8443|' \
  -e 's|^POOLER_TENANT_ID=.*|POOLER_TENANT_ID=teambrain-scratch|' \
  -e 's|^# GITHUB_ENABLED=false|GITHUB_ENABLED=true|' \
  .env && rm -f .env.bak
# Then edit .env manually to fill GITHUB_CLIENT_ID and GITHUB_SECRET on lines that were
# previously "# GITHUB_CLIENT_ID=" / "# GITHUB_SECRET=" — uncomment and paste from the
# TeamBrain-scratch password-manager entry. Do NOT echo the file or grep its values
# afterward; use the field-name+length verification in the "Done when" block instead.
```

**Critical wiring detail.** The `.env` keys are `GITHUB_ENABLED` / `GITHUB_CLIENT_ID` / `GITHUB_SECRET`. Inside `docker-compose.yml`, those are mapped onto the GoTrue container as `GOTRUE_EXTERNAL_GITHUB_*` — but those mapping lines ship **commented out by default**. Uncomment them:

```yaml
# In docker-compose.yml, in the auth service `environment:` block, change:
#   # GOTRUE_EXTERNAL_GITHUB_ENABLED: ${GITHUB_ENABLED}
#   # GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
#   # GOTRUE_EXTERNAL_GITHUB_SECRET: ${GITHUB_SECRET}
#   # GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: ${API_EXTERNAL_URL}/auth/v1/callback
# to (drop the `# `):
      GOTRUE_EXTERNAL_GITHUB_ENABLED: ${GITHUB_ENABLED}
      GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      GOTRUE_EXTERNAL_GITHUB_SECRET: ${GITHUB_SECRET}
      GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI: ${API_EXTERNAL_URL}/auth/v1/callback
```

`GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI` is **auto-derived** from `${API_EXTERNAL_URL}/auth/v1/callback` — there is no separate `.env` field for it. Setting `API_EXTERNAL_URL=https://127.0.0.1:8443` makes the callback `https://127.0.0.1:8443/auth/v1/callback`, which must match the `TeamBrain-scratch` GitHub OAuth app callback exactly (including `127.0.0.1`, not `localhost`).

**Done when** (verification masks all values — never print raw `.env` contents):

```bash
cd ~/scratch/supabase-stack
# Field-name + length only — values stay out of the transcript
for k in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SECRET_KEY_BASE \
         VAULT_ENC_KEY PG_META_CRYPTO_KEY LOGFLARE_PUBLIC_ACCESS_TOKEN \
         LOGFLARE_PRIVATE_ACCESS_TOKEN MINIO_ROOT_PASSWORD DASHBOARD_PASSWORD \
         SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY JWT_KEYS JWT_JWKS \
         GITHUB_ENABLED GITHUB_CLIENT_ID GITHUB_SECRET; do
  v=$(grep "^$k=" .env | cut -d= -f2-)
  if [ -z "$v" ] || [ "$v" = "REPLACE_FROM_PASSWORD_MANAGER" ]; then
    echo "$k: UNSET"
  else
    echo "$k: SET (len=${#v})"
  fi
done

# Confirm leftover placeholders are gone (intentional non-secret defaults are OK)
grep -nE 'your-super-secret|your-tenant-id|your-32-character|your-encryption-key' .env
# (no output = good; commented "# SAML_PRIVATE_KEY=<...>" matching `<` is harmless)

# Confirm docker-compose.yml uncomment
sed -n '197,200p' docker-compose.yml | grep -v '^[[:space:]]*#'
# (should print 4 lines, none starting with #)
```

**S3_PROTOCOL_ACCESS_KEY_*** ships pre-randomized — the rotation scripts don't touch them. Storage isn't used in Phase 1; safe to leave as-is. **OPENAI_API_KEY=sk-proj-xxxxxxxx** is only consumed by Studio's AI Assistant and isn't a secret.

### D4. Bring the stack up (Caddy in-compose, Kong on loopback)

**Topology:** all proxying lives inside the compose stack. Caddy terminates TLS on the host's `127.0.0.1:8443`, then `reverse_proxy kong:8000` over the docker network. Kong is also exposed on `127.0.0.1:8000` for direct debug curls but isn't on the public-facing path. Pooler ports go to loopback too. This mirrors the production topology (`pr.fabric-testbed.net` → Caddy → Kong) so issues found here translate one-to-one.

Add a `docker-compose.override.yml` next to `docker-compose.yml` (auto-merged by compose; do **not** commit to the TeamBrain repo — it's local to `~/scratch/supabase-stack/`):

```yaml
services:
  kong:
    ports: !override
      - "127.0.0.1:${KONG_HTTP_PORT}:8000/tcp"

  supavisor:
    ports: !override
      - "127.0.0.1:${POSTGRES_PORT}:5432"
      - "127.0.0.1:${POOLER_PROXY_PORT_TRANSACTION}:6543"

  caddy:
    image: caddy:2.10-alpine
    container_name: supabase-caddy
    restart: unless-stopped
    depends_on:
      kong:
        condition: service_healthy
    ports:
      - "127.0.0.1:8443:8443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ${HOME}/scratch/tls/127.0.0.1+2.pem:/tls/cert.pem:ro
      - ${HOME}/scratch/tls/127.0.0.1+2-key.pem:/tls/key.pem:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

And a `Caddyfile` next to it:

```caddyfile
{
    auto_https off
    log { level WARN }
}

:8443 {
    tls /tls/cert.pem /tls/key.pem
    reverse_proxy kong:8000
}
```

Caddy auto-sets `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For` and handles WebSocket upgrades by default — no manual headers needed. `auto_https off` is critical: without it Caddy will try to provision Let's Encrypt certs and fail on `127.0.0.1`.

Bring it all up:

```bash
docker compose up -d
docker compose ps
```

**Done when:** every service shows `Up ... (healthy)` (allow ~60s for first start). HTTPS path responds:

```bash
# WORKS — Python uses OpenSSL with the mkcert CA explicitly
ANON=$(grep "^ANON_KEY=" .env | cut -d= -f2-)
CAROOT=$(mkcert -CAROOT)
python3 -c "
import ssl, urllib.request, json
ctx = ssl.create_default_context(cafile='$CAROOT/rootCA.pem')
req = urllib.request.Request('https://127.0.0.1:8443/auth/v1/settings', headers={'apikey': '$ANON'})
with urllib.request.urlopen(req, context=ctx) as r:
    print('status:', r.status, 'github:', json.load(r).get('external',{}).get('github'))
"
# Expect: status: 200 github: True
```

**macOS LibreSSL gotcha.** `/usr/bin/curl` on macOS ships with LibreSSL 3.3.6 and a static CA bundle at `/etc/ssl/cert.pem` that does **not** include the mkcert local CA — even though Keychain does. System curl will fail TLS handshake against `127.0.0.1:8443` with `error:06FFF064:digital envelope routines:CRYPTO_internal:bad decrypt`. Browsers (Secure Transport via Keychain) and Python/Node (OpenSSL) work fine. For command-line testing, either `brew install curl` (puts an OpenSSL-backed curl at `/opt/homebrew/opt/curl/bin/curl`) or use the Python snippet above.

### D5. Verify pgvector is available (in the `extensions` schema)

Supabase's convention is that **all extensions live in the dedicated `extensions` schema**, not in `public`. The `extensions` schema is pre-created by the supabase docker image, and `search_path` is set to `"$user", public, extensions` so unqualified references (`vector(1536)`) resolve transparently. Putting extensions in `public` triggers Studio's Security Advisor "Extension in Public" warning and pollutes the auto-generated PostgREST OpenAPI surface.

```bash
docker compose exec db psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions; SELECT n.nspname AS schema, e.extname, e.extversion FROM pg_extension e JOIN pg_namespace n ON e.extnamespace=n.oid WHERE e.extname='vector';"
```

**If vector is already installed in the wrong schema** (e.g., from an earlier `CREATE EXTENSION` without `WITH SCHEMA`):

```bash
docker compose exec db psql -U postgres -c "ALTER EXTENSION vector SET SCHEMA extensions;"
```

`ALTER EXTENSION ... SET SCHEMA` is non-destructive — it moves the extension's objects (the `vector` type, distance functions, indexes) and any dependent objects atomically.

**Done when:** the row shows `schema=extensions, extname=vector, extversion=0.8.0` (or newer); `'[1,2,3]'::vector(3)` evaluates without a schema-qualifier.

### D6. Verify Studio loads

Studio defaults to plain HTTP on `:3000`. Two acceptable patterns:

- **Direct admin access** (simplest): open `http://127.0.0.1:3000`. Bind it to loopback only in compose (`127.0.0.1:3000:3000`) so it's not reachable from elsewhere.
- **Behind Nginx** at a separate hostname (`https://studio.127.0.0.1.nip.io:8443`-style trick won't work with mkcert SAN; use a separate `server` block with the same cert if you really want HTTPS to Studio).

Pick the first for the spike — Studio is admin-only and the loopback bind is sufficient.

**Done when:** Studio dashboard renders, can browse `auth.users` (empty), can run `SELECT now();` in SQL editor.

### D7. Verify GitHub OAuth round-trip

The simplest harness: a tiny static `index.html` served over HTTPS from the same `https://127.0.0.1:8443` origin (so post-login redirect lands on a trusted-cert origin without origin warnings). Either drop it under Nginx's `root` for the `:8443` server, or stand up a second Nginx server block (or use a Vite dev server with HTTPS pointing at the mkcert files).

```html
<!doctype html>
<script type="module">
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
  const supabase = createClient('https://127.0.0.1:8443', '<ANON_KEY from .env>')
  window.signIn = () => supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: 'https://127.0.0.1:8443/' }
  })
  supabase.auth.onAuthStateChange((evt, session) => console.log(evt, session))
</script>
<button onclick="signIn()">Sign in with GitHub</button>
```

Walk through:
1. Click "Sign in with GitHub" in the harness.
2. Redirect to GitHub → authorize the `TeamBrain-scratch` OAuth App (first time only).
3. Redirect back to `https://127.0.0.1:8443/auth/v1/callback?code=...` → GoTrue exchanges code with GitHub → sets session cookies → final redirect to harness.
4. Studio's `auth.users` table now has one row with `provider=github`.
5. Decode the session JWT (jwt.io or `console.log(session.access_token)` + paste) — `sub` matches `auth.users.id`.

**Done when:** a row exists in `auth.users` with `provider=github`; the JWT contains the correct `sub`; no browser cert warnings appeared.

### D8. Verify `auth.uid()` works in SQL with that user's JWT

In Studio's SQL editor, create a quick `whoami` helper and call it through the authenticated client:

```sql
create function public.whoami() returns uuid language sql security invoker as $$
  select auth.uid();
$$;
```

From the harness page (still signed in):

```js
const { data, error } = await supabase.rpc('whoami')
console.log('auth.uid() →', data)   // should match auth.users.id
```

**Done when:** `auth.uid()` returns the same UUID as `auth.users.id` for the GitHub-authenticated user.

---

## E — Phase 1 readiness gate

Before moving to Phase 1, confirm:

- [x] A1–A4 complete (clean repo, Apache-2.0, initial commit, remotes configured)
- [x] B1 — pilot repo decided (fabric-core-api); Komal's buy-in answers still pending but not blocking schema work
- [x] C1–C2 complete (both OAuth apps registered: `TeamBrain` for prod, `TeamBrain-scratch` for `https://127.0.0.1:8443`)
- [ ] D1–D8 all green on scratch instance

If all four are checked, Phase 1 schema work can begin against the scratch Supabase. The first Phase 1 deliverables (per `CLAUDE.md`) are:

1. `migrations/0001_init.sql`
2. `migrations/0002_rls.sql`
3. `migrations/seed.sql` (manual `project_members` for pilot devs)
4. End-to-end smoke test confirming RLS isolation

---

## Notes for the next session

- Read order on session start: `CLAUDE.md` → `docs/adr/0001-teambrain-architecture.md` → this file.
- Decisions and blockers go to Open Brain with prefix `PROJECT: TeamBrain — `.
- Do **not** touch Michael's personal OB1 Supabase project (`ncldmtgyyikclljevpkm`).
- Do **not** deploy to `pr.fabric-testbed.net` until D7 passes on a scratch instance.
