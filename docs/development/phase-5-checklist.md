# Phase 5 Checklist

Concrete, ordered tasks for Phase 5 — **capture integrations**: a long-lived non-interactive **API token** (the gating prerequisite, § A), a **Slack bot** (channel → `project_id`, § B), a **GitHub Action** that summarizes a merged PR behind a human-approval gate (§ C), and **slash commands** for Claude Code / Cursor (§ D). Each item has an explicit **Done when** acceptance criterion.

Section A is detailed because it is the gate: the runnable GitHub Action (§ C) cannot land until A is green. Sections B and D had **no dependency on A**; § D shipped 2026-06-09 and § B shipped 2026-06-15 (built 2026-06-11; live smoke B5/B6 verified on production). **Phase 5 is complete.**

Phase 5 entry preconditions (from `docs/development/phase-4-checklist.md` § I and the current state of `main`):

- ✅ Phases 0–4 complete on `main`; deployed and live on `pr.fabric-testbed.net`.
- ✅ MCP surface live — 6 tools round-trip (`ping`, `capture_project_thought`, `search_project_thoughts`, `list_recent_project_thoughts`, `mark_stale`, `promote_to_docs`).
- ✅ REST surface live and at parity with MCP; `openapi.yaml` published and lint-clean.
- ✅ Self-service project registration (`teambrain-register-project`) shipped; multiple projects registered.
- ✅ A non-interactive credential for server-to-server callers — § A shipped 2026-05-29 (commits `0b86f85` + `88bb3ce`); end-to-end smoke green on `pr.fabric-testbed.net`.

---

## Architectural shape (the one-pager)

The token mechanism is a **refresh/access split**:

- The **opaque token** (`tbk_<32 random bytes, base64url>`) is the durable, revocable credential. It is stored **only as a SHA-256 hash** (`app.api_tokens.token_hash`); the plaintext is shown exactly once, at issuance. It is never a JWT and is never presented to the MCP/REST surface directly.
- The caller exchanges the opaque token for a **short-lived (15 min) minted JWT** — HS256-signed with `JWT_SECRET`, shaped like a GoTrue access token (`sub` = the project's bot user, `role: authenticated`, `aud: authenticated`). That JWT drives the existing MCP/REST surface through the **existing RLS** — no new happy-path policy logic.

**Why an exchange rather than presenting the token directly** (both verified against the deployed code):

- `teambrain-mcp/index.ts:65` decodes the `Authorization` bearer as a 3-segment JWT, and PostgREST verifies the signature against `JWT_SECRET`. An opaque string satisfies neither — so it must be exchanged for a real JWT first.
- The Edge Runtime dispatcher's JWT check is **global, not per-function** (`volumes/functions/main/index.ts:7`, a single `VERIFY_JWT` flag). The exchange endpoint therefore satisfies the gateway with the **public `ANON_KEY`** as its `Authorization` bearer (a valid HS256 JWT, not a secret) and carries the real opaque token in an `X-TeamBrain-Token` header. This works whether `VERIFY_JWT` is on or off and needs **no dispatcher modification**.
- `JWT_SECRET` is already injected into every function worker (the dispatcher reads it at `main/index.ts:5` and forwards the whole container env at `:148`), so minting needs no new env wiring — only a confirmation it is present.

Revocation takes effect within the 15-minute access-token TTL: every exchange re-checks `revoked_at`/`expires_at`, so a revoked opaque token stops minting JWTs on its next refresh.

The issuance/exchange function is **`teambrain-token`** — distinct from the `teambrain-auth` name § J reserved for the (still-deferred) developer-side JWT-refresh daemon.

---

## A — API token mechanism (the Phase 5 gating item) — *complete (2026-05-29)*

### Decisions locked before coding

- **A‑D1. Token model** — *resolved: opaque refresh token (hashed at rest) → short-lived minted JWT.* Standard refresh/access split; minted JWT is HS256 over `JWT_SECRET` so both the gateway and PostgREST accept it.
- **A‑D2. Principal identity** — *resolved: per-project service account.* Each project gets one bot (`auth.users` row, `user_metadata.teambrain_bot = true`) plus a `project_members` row (`role: contributor`, `is_service_account: true`). Provisioned lazily on first token issuance. Per-project keeps provenance clean (`thoughts.author_user_id` identifies the source project's bot) and bounds a leak to one project.
- **A‑D3. RLS enforcement** — *resolved: mint a JWT and reuse RLS verbatim* (no service_role + manual filter). `contributor` is the floor — `0002`'s `thoughts_insert_self` (line 178) requires `is_project_writer` to capture `project` scope.
- **A‑D4. Capabilities** — *resolved: capture + read, no `project_private`; enforced in RLS via JWT claim* (call **a**). A friendly app-layer guard in MCP/REST is a UX nicety, **not** the boundary: the minted JWT is a valid contributor token that could otherwise hit PostgREST directly, so the limit must live in RLS. Concretely: `mark_stale`/`promote_to_docs` (updates) and deletes are denied for token calls at the DB; `project_private` is filtered out of reads and rejected on writes.
- **A‑D5. Opaque-token lifetime** — *resolved: default `expires_at = now() + 180 days`, plus explicit revocation* (call **b**). Non-expiring is not the default.
- **A‑D6. Gateway pass-through** — *resolved: `Authorization: Bearer <ANON_KEY>` (public) + `X-TeamBrain-Token: tbk_…`* on the exchange call. No `main/index.ts` change.

### A1. Migration `migrations/0012_api_tokens.sql`

- `app.api_tokens` (in the `app` schema, off the PostgREST-exposed surface like the `0002` helpers; RLS enabled, grants to `service_role` only): `id`, `token_hash` (unique), `token_prefix`, `principal_user_id` → `auth.users`, `project_id` → `public.projects`, `allowed_tools text[]`, `allowed_scopes text[]`, `name`, `created_by`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`.
- `public.projects.bot_user_id uuid` (nullable, → `auth.users`) — explicit per-project bot pointer.
- `public.project_members.is_service_account boolean not null default false` — the membership-sync exemption flag (§ A3).
- New `app` helpers (read `current_setting('request.jwt.claims', true)::jsonb`, `stable`, `set search_path = ''`, `grant execute … to authenticated`): `app.is_token_call()` → true when the `teambrain_token` claim is present; `app.token_allowed_scopes()` → the claim's scope array (or `null`).
- Amend `public.thoughts` policies (drop/recreate, single transaction, mirroring `0002`'s style):
  - `thoughts_select` / `thoughts_insert_self`: AND-in `(not app.is_token_call() or scope = any(app.token_allowed_scopes()))`.
  - `thoughts_update_self_or_writer` / `thoughts_delete_own_or_admin`: AND-in `(not app.is_token_call())`.

**Done when:** the migration applies clean via Studio; the existing Phase 2/4 smoke (human JWT) is unchanged; a synthetic bot JWT (`teambrain_token: true`, `teambrain_allowed_scopes: ["project","personal"]`) can `INSERT` a `project`-scope row, is **denied** a `project_private` insert and **denied** any `UPDATE`/`DELETE`, and `SELECT` returns no `project_private` rows.

### A2. Edge function `edge-functions/teambrain-token/` (`index.ts` + `deno.json`)

Reuses the `teambrain-register-project` patterns (service-role client, `{sub, role}` claim parse, `app.is_project_admin` gate). Routes:

- `POST /token` — **admin only** (caller's user JWT). Lazily provisions the project bot via `service.auth.admin.createUser(…)`, stamps `projects.bot_user_id`, inserts the `project_members` row (`contributor`, `is_service_account: true`). Generates `tbk_…`, stores **only** its SHA-256, returns the plaintext **once**.
- `GET /token?project=…` — **admin only**. Lists token metadata (prefix, name, `last_used_at`, `expires_at`, `revoked_at`) — never the hash or plaintext.
- `POST /token/{id}/revoke` — **admin only**. Sets `revoked_at` (soft; no `DELETE`).
- `POST /token/exchange` — anon-key gateway pass + `X-TeamBrain-Token`. Hash → lookup → reject if `revoked_at`/`expired` → bump `last_used_at` → mint a 15-min HS256 JWT (`sub` = `bot_user_id`, `role`/`aud` = `authenticated`, custom claims `teambrain_token: true`, `teambrain_allowed_scopes`, `teambrain_allowed_tools`). Returns `{ access_token, expires_in }`.

**Done when:** an admin can create/list/revoke; a non-admin gets `403`; exchange returns a JWT that `teambrain-mcp` accepts and resolves to the bot's `auth.uid()`; a revoked or expired token fails exchange with a structured error (not a 500).

### A3. Membership-sync bot exemption

`teambrain-membership-sync/sync.ts` would otherwise tombstone the bot every cron run — it has no GitHub handle, so it is never in the "desired" set and falls into the removal loop (`sync.ts:262-269`). Fix: add `is_service_account` to the `project_members` select (`sync.ts:223`) and `continue` past service-account rows in the removal loop (`sync.ts:264`).

**Done when:** a manual `/sync` with the bot present reports it in neither `removed` nor `restored`, and the bot's `project_members.removed_at` stays `null` across a full sync.

### A4. Capability guard in `teambrain-mcp` + `teambrain-rest` (UX layer)

Read `teambrain_token` / `teambrain_allowed_tools` from the JWT; when present, reject a disallowed tool (`mark_stale`, `promote_to_docs` for the capture+read token) with a clear "not permitted for this token" error rather than letting it fail as an opaque RLS denial; intersect requested search/list scopes with `teambrain_allowed_scopes`. Human JWTs (no claim) are unaffected.

**Done when:** a bot-token JWT calling `mark_stale` gets a clear app-level rejection; `capture`/`search`/`list_recent` succeed; a `project_private` capture is refused with a comprehensible message (and RLS backstops it regardless).

### A5. Examples + OpenAPI

- Rewrite `examples/github-actions/capture-on-merge.yml` from the Phase 4 *illustrative* stub to the real flow: exchange `tbk_` → mint JWT → (LLM summarizes merge) → **human-approval gate** (GitHub Environment protection) → `capture_project_thought`.
- Add a curl recipe for the exchange call (anon key + `X-TeamBrain-Token`).
- Extend `nginx/html/openapi.yaml` (3.1) with `/token`, `/token/{id}/revoke`, and `/token/exchange`, documenting the exchange's anon-key + `X-TeamBrain-Token` auth shape.

**Done when:** `actionlint` clean; spec re-validates lint-clean with `openapi-spec-validator`; the curl exchange recipe runs against production.

### A6. Deploy + end-to-end smoke

- Confirm `JWT_SECRET` is in the functions service env (expected — the stock dispatcher reads it); add to the `override.yml` passthrough only if missing (and if so, `cp` to the box per the override-is-a-copy rule).
- Apply `0012` via Studio; rsync `teambrain-token/` into `~/supabase-stack/volumes/functions/` (no `--delete` — the earlier footgun wiped stock `main/`/`hello/`); redeploy patched `teambrain-mcp` / `teambrain-rest` / `teambrain-membership-sync`.
- **Reload PostgREST's schema cache** after `0012` (`NOTIFY pgrst, 'reload schema'`, or bounce the `rest` container) so the new `public.api_tokens` table is visible — otherwise the `teambrain-token` service client gets a 404/`PGRST205` on it.
- Smoke: **Michael** creates the token in his own shell (plaintext returned once — not echoed through Claude) → exchange → capture a `project` thought → confirm `project_private` capture and `mark_stale` are denied → revoke → confirm exchange now fails.

**Done when:** the full smoke passes on `pr.fabric-testbed.net`.

### A7. Commit

**Done when:** `main` on both remotes contains `0012`, `teambrain-token/`, the `sync.ts` / MCP / REST patches, the examples, the spec update, and this checklist; production is deployed and § A6 is green.

---

## B — Slack surface: `/tb` slash command (channel → `project_id`) — *built 2026-06-11; **SHIPPED 2026-06-15** — live smoke B5/B6 verified on production*

A `/tb` slash command (`remember` / `recall` / `recent` / `status` / `link` / `help`) over the existing backend. The channel the command is typed in resolves the project via a new `slack_channels` mapping table — the "channel → `project_id`" requirement. Adoption kit: `examples/slack/README.md` (+ app manifest); server deploy: `deploy/production/README.md` § 11c.

### Decisions locked (2026-06-11)

- **B‑D1. Interaction model — slash command, NOT OB1's message inbox.** OB1's slack-capture (the named pattern this adapts) captures *every* message in a dedicated channel — right for a single-user inbox, wrong for a team channel (over-capture; the § C capture-discipline lesson). `/tb remember` keeps capture explicit and lets recall live in the same channel where the conversation happens. Channel-scoping is retained — that was the actual § B requirement. Reaction-based capture of existing messages (:brain: → capture, via Events API + bot token) is the natural follow-up (B‑F1), deliberately not v1.
- **B‑D2. Channel → project mapping — `public.slack_channels` (migration `0023`),** service_role-only (0012-style lockdown + 0016-style explicit deny-all). Unique on `(slack_team_id, slack_channel_id)`: a channel maps to at most one project (re-pointing requires an explicit unlink → 409 otherwise); a project may have many channels. Managed only via project-admin-gated routes on the function (`POST/GET /links`, `DELETE /links/:id`) — the same admin gate as token CRUD (§ A2). `last_used_at` stamped per command (ops signal, mirrors `api_tokens`).
- **B‑D3. Principal + write path — per-project bot, minted JWT, REST surface.** Commands run as the project's § A bot (provisioned lazily with the same `ensureBotUser` logic): the function mints a **5-min** HS256 JWT with the same claim shape as `/token/exchange` (`teambrain_token: true`, `teambrain_token_id` = link-row id for provenance) and calls `teambrain-rest` over the in-stack `SUPABASE_URL` — same RLS, same 0012 capability fence, no `service_role` in the data path (OB1's shortcut, rejected per the § A constraint). No opaque `tbk_` token is stored for Slack: the link row is the durable authorization and deleting it revokes the path within the JWT TTL. The § A fence invariant holds — this is a second *server-side* minting site (same trust domain as `teambrain-token`: both hold `JWT_SECRET` + service_role), with strictly narrower capabilities.
- **B‑D4. Capabilities — capture + read, `project` scope ONLY.** Narrower than § A token defaults (`project` + `personal`): a shared channel must never read or write anyone's `personal` (or `project_private`) memories. Enforced at the DB by the 0012 fence via the JWT claims, not just app code.
- **B‑D5. Authn — Slack request signature (HMAC v0, ±5 min, constant-time).** The signing secret (`SLACK_SIGNING_SECRET`) is the *only* Slack credential held: the app is slash-command-only — **no bot token, no Events API, no interactivity** — because replies ride the slash payload's `response_url` (valid 30 min, unauthenticated). Smallest possible Slack-side surface; one secret to rotate.
- **B‑D6. Gateway — nginx injects the public anon key on the webhook path only.** Slack cannot send a custom `Authorization` header, but the Edge-Runtime dispatcher's `VERIFY_JWT` gate is global. An `^~` location for `/functions/v1/teambrain-slack/slack/` sets `Authorization: Bearer ${ANON_KEY}` (envsubst; same filtered mechanism as the landing-page `sub_filter`) — the § A "public JWT satisfies the gateway, the real credential rides elsewhere" shape. `^~` outranks the generic regex location, so `/links*` still requires a real caller JWT. No dispatcher modification.
- **B‑D7. The 3-second budget — ACK now, deliver via `response_url`.** `remember`/`recall`/`recent` involve an embedding round-trip; the handler ACKs ephemerally ("Capturing…") and runs the work under `EdgeRuntime.waitUntil`, posting the result to `response_url` (inline-await fallback if `waitUntil` is absent). `help`/`status`/`link` answer inside the ACK.
- **B‑D8. Visibility — `remember` confirms `in_channel`** (a shared-memory capture is a team event; the echoed invocation shows who ran it); `recall`/`recent`/errors are ephemeral.
- **B‑D9. Linking is REST-only, never in-Slack.** A Slack user does not map to a GitHub identity, so `/tb link` cannot authorize — it returns the link recipe pre-filled with the channel's IDs; the admin proves project-admin rights by calling `POST /links` with their GitHub-OAuth JWT. (Identity linking Slack↔GitHub is out of scope for the pilot.)
- **B‑D10. Trust model accepted:** linking a channel makes Slack channel membership the capture/read ACL for that project's `project`-scope memories (documented prominently in `examples/slack/README.md`). Capture attribution: author = project bot; the human is carried in `slack-user:<name>` / `slack-channel:<name>` tags and the in-channel confirmation.

### B1. Migration `migrations/0023_slack_channels.sql` — *built*

**Done when:** applies clean via Studio after `0001`–`0022`; `select` confirms RLS on, deny-all policy present, grants service_role-only (verification queries in the file footer).

### B2. Edge function `edge-functions/teambrain-slack/` — *built (`index.ts` + `slack.ts` + `deno.json`)*

Routes: `POST /slack/command` (signature-verified slash receiver), `POST /links` / `GET /links?project=` / `DELETE /links/:id` (admin), `GET /health`. Reuses the `teambrain-token` scaffolding (HttpError/onError, decode-only claims, `requireProjectAdmin`, `ensureBotUser`, `SignJWT` mint).

**Done when:** `scripts/deno-check.sh teambrain-slack` is green ✅ (2026-06-11); unsigned/stale-timestamp POSTs to `/slack/command` → 401; unset `SLACK_SIGNING_SECRET` → 503 with the rest of the function alive; the minted JWT is denied `mark_stale`/`promote_to_docs`/`project_private` by the fence (claims-level, same as § A4's verified behavior).

### B3. Deploy wiring — *built*

`docker-compose.override.yml` (`SLACK_SIGNING_SECRET`, `SUPABASE_PUBLIC_URL` passthrough), `env.template` block, nginx template `^~` location (B‑D6), runbook `deploy/production/README.md` § 11c (incl. a synthetic signed-request smoke that needs no Slack app), and the § 8 rsync loops now list `teambrain-slack` (+ retroactively `teambrain-staleness`, which Phase 6 § C deployed but never added).

**Done when:** § 11c's pre-Slack smoke passes on production: `/health` shows `slack_command_enabled: true`, unsigned POST → 401, synthetic signed `/tb help` → 200 with help text.

### B4. Contract + examples — *built*

OpenAPI: `slack` tag + `/teambrain-slack/links*` paths + schemas (`openapi-spec-validator` → OK ✅); webhook deliberately excluded from the contract (not bearer-authenticated; noted in the tag description). `examples/curl.md` § 10 (link management). `examples/slack/README.md` + `manifest.yml` (app from manifest: one command, one `commands` scope).

**Done when:** ✅ spec validates; the curl recipes run against production (B5 done 2026-06-15).

### B5. Slack app + server config — *Michael-driven; done 2026-06-15*

- Create the app from `examples/slack/manifest.yml` in the FABRIC Slack workspace; install; copy the **signing secret**.
- On the VM per § 11c: apply `0023`, set `SLACK_SIGNING_SECRET` in `.env`, `cp` the override (copy-not-symlink), `git pull` (nginx template is bind-mounted from the checkout), recreate `functions` + `nginx`, rsync the function.

**Done when:** ✅ **DONE 2026-06-15** — § 11c smoke green on production (`/health` → `slack_command_enabled: true`, unsigned POST → 401, synthetic signed `/tb help` → 200).

### B6. End-to-end smoke in Slack — *done 2026-06-15*

Link a channel to `fabric-testbed/TeamBrain` (dogfood) via the `/tb link` → curl flow, then in-channel: `/tb status` → linked; `/tb remember <real gotcha>` → in-channel confirmation, retrievable via MCP `search_project_thoughts`; `/tb recall` → ephemeral ranked hits; `/tb recent` → listing; an unlinked channel → the not-linked guidance; after `DELETE /links/:id` → commands refuse again.

**Done when:** ✅ **DONE 2026-06-15** — `#teambrain` linked to `fabric-testbed/TeamBrain`; `/tb remember` from Slack landed thought `9e833759` (tags carry `slack` + `slack-user:stealey` + `slack-channel:teambrain`; author = project bot), retrieved via MCP `search_project_thoughts` at 0.81 similarity. (Gotcha: a slash command only registers on app **(re)install** — the first `/tb` returned "not a valid command" until the FABRIC workspace reinstalled the app.)

### B‑F. Follow-ups (deliberately not v1)

- **B‑F1.** Reaction-capture of existing messages (`:brain:` → capture with permalink provenance) — needs Events API + bot token (`reactions:read`, `channels:history`, `chat:write`); revisit if the pilot shows teams wanting to capture *conversation* rather than retype summaries.
- **B‑F2.** Search-first dedup confirmation for `/tb remember` (needs Slack interactivity/buttons).
- **B‑F3.** Slack↔GitHub identity linking (would enable in-Slack linking and per-human attribution).

**§ B done when:** ✅ **MET 2026-06-15** — B5 + B6 green on production. § B + § D are both shipped, opening the "connect & capture from every surface" reference (`docs/documentation-plan.md` § 3).

---

## C — GitHub Action: PR-merge summarization — *consumes A; **COMPLETE 2026-05-30** — deployed + smoke-verified end-to-end on the `fabric-testbed/TeamBrain` dogfood repo*

The runnable version of the Phase 4 illustrative example, and the API token's first real consumer. On PR merge, a **server-side** LLM step proposes 0–3 candidate captures from the merged PR's metadata; the proposals are surfaced in the workflow run summary; a **human-approval gate** (GitHub Environment) must pass before anything is written; on approval the approved set is captured against the REST surface under the project bot's short-lived JWT. First target is the dogfood repo `fabric-testbed/TeamBrain`. Shipping this end-to-end satisfies the Phase 6 readiness gate.

### Decisions locked (2026-05-30)

- **C‑D1. Job topology** — two jobs in one workflow: `propose` (ungated) → `capture` (`needs: propose`, Environment-gated). Each job exchanges its **own fresh** 15‑min JWT from the opaque `tbk_` token (the durable credential, held as a repo secret). A single minted JWT cannot span the approval wait — a human may take hours — so the capture job re‑exchanges *after* the gate rather than reusing the propose job's JWT.
- **C‑D2. Summarization location** — *server-side* `edge-functions/teambrain-summarize/`. The AI key and the proposal prompt live in one place; every adopting repo's workflow stays AI‑key‑free and prompt‑free (per TeamBrain's "new client = config, not code"). The Action just POSTs a PR payload and renders the returned proposals.
- **C‑D3. AI provider/model** — *resolved 2026-05-30: FABRIC's LiteLLM gateway* (`ai-renci.fabric-testbed.net`), which exposes an Anthropic-`/v1/messages`-compatible endpoint, with model **`gpt-5.4-mini`** (a light extraction task; configurable via `TEAMBRAIN_SUMMARIZE_MODEL`). `teambrain-summarize` speaks that same wire format, so only the endpoint + auth changed, not the request: it reads `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (Bearer), wired via the `override.yml` passthrough and `cp`'d to the box (override‑is‑a‑copy rule). The code default stays Anthropic-direct (`claude-sonnet-4-6` over `api.anthropic.com`) for portability.
  - **Egress finding (corrects the earlier "revisit before broadening" hedge):** the ai-renci catalog is entirely **OpenAI-backed** (`gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex / 5.2` — no self-hosted/open-weights option), so routing through it does **not** remove third-party egress — PR metadata still reaches OpenAI via the gateway. The win is **governance**: a FABRIC-owned key + billing + rotation + single audit point, replacing a personal key. Marginal egress is ~zero because OpenAI is **already in TeamBrain's data path** via the embedding provider. The genuine "no third-party AI vendor in the data path" goal would require a self-hosted model the catalog does not currently offer. Tracked with the embedding-provider open decision — `embedding.ts` now also accepts `OPENAI_BASE_URL`, so embeddings can ride the same FABRIC key/gateway (keep a 1536-dim model to avoid a schema migration).
- **C‑D4. LLM input (egress boundary)** — PR **metadata only**: title, body, commit messages, and changed-file *paths*. **No diff contents.** Keeps the prompt bounded, avoids leaking secrets that live in diffs to a third‑party model, and is the conservative default given C‑D3. A bounded, secret‑scrubbed diff is a future option, not Phase 5.
- **C‑D5. Approval gate mechanism** — *revised 2026-05-30:* native GitHub **Environment required-reviewers are unavailable** on this private repo. (`fabric-testbed` is on the Team plan, but the API returns `422 — "ensure the billing plan supports the required reviewers protection rule"`; that rule needs GitHub Enterprise for private repos, or a public repo.) So the gate is an **issue-based approval** via `trstringer/manual-approval` (SHA-pinned `74d99df` / v1.12.0): the `capture` job opens an issue listing the proposals, @-mentions the approver(s) (repo var `TEAMBRAIN_APPROVERS`, default = the PR merger `github.actor`), and blocks until one comments `approved` (writes) or `denied` (discards all). Still **binary** (approve-all / reject-all); per-proposal curation deferred. Upside over the native gate: the proposals render **inline in the issue**, so the approver reviews them without leaving the issue. Requires `issues: write` on the `capture` job.
- **C‑D6. Capture shape** — proposals are constrained to the token's default capability: `scope: project` only, `type ∈ {decision, convention, gotcha, context}`, `confidence: tentative`, tags include `pr-merge` + `auto-capture`, and every capture carries `linked_pr_url` + `linked_commit_sha`. No `project_private`, no `mark_stale`/`promote_to_docs` (RLS backstops this regardless — see § A4).
- **C‑D7. Idempotency** — the REST read surface does not expose `linked_pr_url` (neither `GET /thoughts` nor `/thoughts/search` returns it), so the capture job dedups on a **deterministic per-PR tag** (`owner/repo#N`) instead: it lists recent thoughts (`GET /thoughts`, which *does* return `tags`) and skips the whole capture if any already carries that tag. Robust for the realistic re‑run (the original is still recent); a re‑run after 100+ newer captures would fall outside the window and miss it — accepted for the pilot. The clean future fix is a `linked_pr_url` filter on `GET /thoughts` (which would also serve Phase 6 staleness-by-PR).
- **C‑D8. Prompt-injection posture** — PR title/body are **untrusted** input to the LLM; a hostile PR could try to steer the proposals. The human‑approval gate is the security backstop — nothing is written without a reviewer seeing the exact proposals first. PR‑controlled strings reach the shell only via env + `jq --arg`, never spliced into the script (the existing example already does this).
- **C‑D9. First target** — dogfood `fabric-testbed/TeamBrain` (already a registered project).

### C1. Edge function `edge-functions/teambrain-summarize/` (`index.ts` + `deno.json`)

`POST /teambrain-summarize/propose` — authenticated by any valid JWT (the gateway's global `VERIFY_JWT`; in practice the project bot's minted JWT). Reuses the `teambrain-token`/`teambrain-rest` scaffolding (`HttpError` + `onError`, decode-only JWT, structured errors). Body: `{ project_slug, title, body, commits: string[], changed_paths: string[] }`. Calls Claude (`ANTHROPIC_API_KEY`, model per C‑D3) with a fixed prompt that returns **0–3** proposals as strict JSON, each `{ content, type, scope: "project", tags }`. Writes nothing — generation only. Returns `{ project_slug, count, proposals: [...] }` (possibly empty). *(Built 2026-05-30: `index.ts` + `summarize.ts` + `deno.json`, deno-type-clean; deploy/smoke pending C4/C6.)*

**Done when:** a valid-JWT POST with sample PR metadata returns 0–3 well-formed proposals as JSON; an unauthenticated call is rejected by the gateway; a malformed/oversized body returns a structured 4xx, not a 500; the function never writes to `thoughts`.

### C2. Rewrite `examples/github-actions/capture-on-merge.yml` to the two-job flow

- `permissions: contents: read, pull-requests: read`.
- **Job `propose`** (`if: pull_request.merged == true`): gather PR metadata (event payload for title/body/url/number/sha; `gh api` for commit messages + changed-file paths under `GITHUB_TOKEN`), exchange `tbk_` → JWT, POST to `/teambrain-summarize`, render the proposals to `$GITHUB_STEP_SUMMARY` (human-readable), persist them as a job artifact / `outputs.proposals`, and set `outputs.has_proposals`.
- **Job `capture`** (`needs: propose`, `if: needs.propose.outputs.has_proposals == 'true'`, `environment: teambrain-capture`): on approval, read the proposals, exchange a **fresh** `tbk_` → JWT, dedup by `linked_pr_url` (C‑D7), then POST each to `/teambrain-rest/thoughts` with provenance + tags. Warn (don't fail the merge pipeline) on any capture hiccup; mask the minted JWT (`::add-mask::`).

**Done when:** `actionlint` is clean; a dry inspection shows no PR-controlled value reaching the shell except via env + `jq --arg`; the gate sits between proposal and any write; `has_proposals == false` skips the `capture` job (no pointless approval prompt). *(Built 2026-05-30, gate revised same day: `propose → issue-approval → capture`. Proposals pass via job outputs — `proposals` (compact JSON) drives the writes, `proposals_md` is the approval-issue body. Gate is `trstringer/manual-approval` (SHA-pinned), since native Environment reviewers aren't available on this plan — see C‑D5. Dedup per C‑D7. `actionlint` + `shellcheck` clean. Live smoke pending C4/C6.)*

### C3. OpenAPI + curl

- Add `/teambrain-summarize` to `nginx/html/openapi.yaml` (3.1): JWT auth, request (PR payload), response (`proposals[]`).
- Add a curl recipe (exchange → summarize → inspect proposals) to `examples/curl.md`.

**Done when:** spec re-validates lint-clean with `openapi-spec-validator`; the curl recipe runs against production and returns proposals; tail-verify the spec for stray wrapper tags after editing (the gotcha that bit this very checklist). *(Built 2026-05-30: `summarize` tag + `/teambrain-summarize/propose` path + `ProposeRequest`/`Proposal`/`ProposeResult`/`SummarizeError` schemas; `openapi-spec-validator` → OK; curl § 9 added. Live "runs against production" check pending C4/C6.)*

### C4. Deploy `teambrain-summarize` + wire the AI key

- Add `ANTHROPIC_API_KEY` (and optional `TEAMBRAIN_SUMMARIZE_MODEL`) to the functions service env via `deploy/production/docker-compose.override.yml` passthrough; `cp` the override to `~/supabase-stack/` on the box (copy‑not‑symlink) and recreate the functions service.
- rsync `teambrain-summarize/` into `~/supabase-stack/volumes/functions/` (**no `--delete`** — the footgun that wiped stock `main/`/`hello/`).

**Done when:** ✅ `POST /functions/v1/teambrain-summarize/propose` returns proposals for a sample payload. *(Done 2026-05-30 — routed through the FABRIC ai-renci LiteLLM gateway with `gpt-5.4-mini` per C‑D3; user-JWT smoke returned 200 + a clean proposal.)*

### C5. Dogfood rollout (Michael-driven steps)

- Michael issues a `tbk_` token for `fabric-testbed/TeamBrain` in his own shell (plaintext returned once — not echoed through Claude); store it as the repo **secret** `TEAMBRAIN_TOKEN`; add the public anon key as the repo **variable** `TEAMBRAIN_ANON_KEY`.
- ~~Create the `teambrain-capture` Environment with Michael as a Required reviewer.~~ **N/A** — native Environment reviewers aren't available on this plan (see C‑D5); the gate is in-workflow (issue-based). Approver defaults to the PR merger (`github.actor`); override via repo var `TEAMBRAIN_APPROVERS`.
- Land `capture-on-merge.yml` in `.github/workflows/` of `fabric-testbed/TeamBrain`.

**Done when:** ✅ the workflow is on `main` (`.github/workflows/capture-on-merge.yml`) and the `TEAMBRAIN_TOKEN` secret + `TEAMBRAIN_ANON_KEY` variable are set (verified 2026-05-30 via `gh secret/variable list`). The vestigial `teambrain-capture` Environment was deleted.

### C6. End-to-end smoke on a real PR

Open → merge a small real PR in the dogfood repo. The `propose` job posts 0–3 proposals to the run summary; the `capture` job opens an issue-based approval gate; Michael comments `approved`; the captures land tagged `owner/repo#N`; each is retrievable via `search_project_thoughts`; a workflow re-run dedups and writes nothing.

**Done when:** ✅ **DONE 2026-05-30.** Smoke on PR #1 (gitignore `deno.lock`): `gpt-5.4-mini` proposed **3** well-typed captures (convention / context / gotcha) → approved → all 3 landed under the project bot, retrievable at search similarity 0.70–0.79; a re-run wrote **0** duplicates (confirmed from the data — still exactly three `fabric-testbed/TeamBrain#1`-tagged thoughts).

### C7. Commit

**Done when:** ✅ `main` on both remotes has it all — commits `b8fac12` (§ C build), `faea62c` (gateway), `95c16b2` (issue gate), `1f9e266` (workflow in `.github/workflows/`); production has `teambrain-summarize` deployed and the dogfood repo wired; § C6 green.

**§ C done when:** ✅ **MET 2026-05-30** — a merged PR in `fabric-testbed/TeamBrain` produced LLM-proposed captures that, after human approval, landed in TeamBrain and are retrievable. **The Phase 6 readiness gate is now open.** Remaining in Phase 5 at the time: § B (Slack bot) and § D (slash commands) — **both now shipped (§ D 2026-06-09, § B 2026-06-15); Phase 5 complete.**

---

## D — Slash commands for Claude Code / Codex / Cursor — *in progress (2026-06-09), not gated on A*

One-keystroke interactive shortcuts for capture/recall over the **already-connected**
`teambrain` MCP server. **No server-side change** — these are repo-committed *prompt
templates* that drive the existing MCP tools; the MCP connection (per `AGENTS.md`) is the
prerequisite. The highest-value capture/recall ergonomics for a dev-tool pilot, and a
lighter lift than § B.

### Decisions locked (2026-06-09)

- **D‑D1. Command set (3 primitives, namespaced):** `/tb-remember` (capture),
  `/tb-recall` (search), `/tb-recent` (list recent). The `tb-` prefix avoids collisions
  with built-ins / other command packs. `mark_stale` / `promote_to_docs` are intentionally
  **excluded** — deliberate, low-frequency, agent-judgment actions, better triggered in
  prose than a hotkey (keeps capture discipline, per the § C over-capture lesson).
- **D‑D2. `project_slug` resolution:** auto-derived from `git remote get-url origin` →
  `owner/repo`, so the *same* command file is copy-anywhere ("config, not code"). Claude
  Code pre-resolves it deterministically via an inline `` !`git remote get-url origin` ``
  injection; Codex/Cursor instruct the agent to run that git command in prose (those clients
  lack the injection feature).
- **D‑D3. Capture hygiene:** `/tb-remember` **searches first**; on a high-similarity hit it
  surfaces the existing memory and asks before writing; otherwise captures (`scope: project`
  default, type inferred, content from the argument string, tag `slash-capture`).
- **D‑D4. Client scope + the "don't ship untested instructions" rule:** Claude Code and
  Codex are smoke-testable today (both in active use on this repo) — Claude Code's tool path
  is verified this session (§ D5), Codex's is a Michael-driven confirmation; **Cursor is not**
  (no account yet — the same gap that defers the Cursor entry in `AGENTS.md` → "How to
  connect", thought `5fc671cf`), so it ships as a clearly-marked **untested template**, ready
  to flip on once an account exists.
- **D‑D5. AI-agnostic posture:** slash commands are client-specific (like the `.mcp.json`
  we deliberately did *not* commit, thought `5fc671cf`), so the mitigation is **parity**
  across clients + framing them as **optional sugar** over the canonical MCP doorway, with
  tool-neutral command bodies.

### D1. Claude Code commands — *committed, dogfood + canonical template*

`.claude/commands/{tb-remember,tb-recall,tb-recent}.md`. Each declares `allowed-tools`
(`Bash(git remote get-url:*)` + the relevant `mcp__teambrain__*` tools), injects the origin
URL, derives the slug, and drives its tool. `tb-remember` does the search-first dedup.

**Done when:** ✅ the three files exist and parse; an in-repo `/tb-remember` lands a capture
retrievable via `/tb-recall`; `/tb-recent` lists. (Claude-driven tool-path smoke green
2026-06-09 — see § D5; the `/`-keystroke confirmation is a Michael-driven step.)

### D2. Codex skills — *committed, repo-discovered*

`.agents/skills/{tb-remember,tb-recall,tb-recent}/SKILL.md`. Codex
[custom prompts are deprecated](https://developers.openai.com/codex/custom-prompts) in favor
of [skills](https://developers.openai.com/codex/skills), which — unlike `~/.codex/prompts/`
— are discovered from `$REPO_ROOT/.agents/skills/`, so they're **committed and shared** (no
per-developer install), at parity with the Claude Code commands. Each skill is a directory
with a `SKILL.md` (`name` + `description` frontmatter). Invoked via `/skills` / `$`-mention,
or triggered implicitly from the `description`. No `$ARGUMENTS` placeholder (skills are
instructions; the user's message supplies specifics); prose slug-detection from
`git remote get-url origin`. *(Converted from the deprecated custom-prompt format 2026-06-09.)*

**Done when:** in Codex opened on this repo, `/tb-remember …` captures and `/tb-recall …`
retrieves against `fabric-testbed/TeamBrain` (Michael-driven). Copy-anywhere:
`cp -r .agents/skills/tb-* <other-repo>/.agents/skills/`.

### D3. Cursor command templates — *committed, marked untested*

`examples/slash-commands/cursor/{tb-remember,tb-recall,tb-recent}.md` (→ `.cursor/commands/`).
Each carries a top-of-file `UNTESTED` marker per D‑D4.

**Done when:** templates exist and are marked untested. Real smoke deferred until a Cursor
account exists.

### D4. Adoption kit + docs

`examples/slash-commands/README.md` (what the commands do, the MCP-connected prerequisite,
per-client install with the tested/untested badges). Plus: a short "Slash commands (optional)"
note in `AGENTS.md`, a `docs/getting-started.md` pointer, and the `CLAUDE.md` Repository State
bump.

**Done when:** README + the three doc touch-points are in place.

> **Docs trigger (partial):** the documentation-plan's "connect & capture from *every*
> surface" reference is gated on **§ B (Slack) *and* § D** shipping (decision `86dcc985`).
> § D ships its own adoption kit here; the unified reference still waits on § B.

### D5. Smoke

- **Claude-driven tool-path smoke (this session):** ✅ 2026-06-09 — derived
  `fabric-testbed/TeamBrain` from the origin remote; `search_project_thoughts` (dedup) →
  `capture_project_thought` (the § D milestone memory) → `search_project_thoughts` confirmed
  retrievable. Exercises the exact tool sequence `/tb-remember` drives.
- **Michael-driven:** `/tb-remember` / `/tb-recall` / `/tb-recent` in a fresh Claude Code
  session; the same three as Codex skills (`/skills`) with Codex opened on this repo.

**Done when:** the Claude-driven path is green (✅) and the Michael-driven confirmations pass.

### D6. Commit

**Done when:** `main` on both remotes carries the `.claude/commands/`, the `.agents/skills/`
Codex skills, the `examples/slash-commands/` kit, and the doc updates; PR merged.

**§ D done when:** the three commands ship for Claude Code (committed commands) + Codex
(committed `.agents/skills/`) with a marked Cursor template, the adoption kit + docs are in
place, and the Claude-driven tool-path smoke is green. Codex's in-Codex smoke is a
Michael-driven confirmation; Cursor's live smoke is deferred (no account).

---

## Phase 6 readiness gate

Phase 6 (staleness & promotion: `last_verified_at` decay in ranking, commit-triggered staleness via webhook, `promote_to_docs` generating ADR/docs PRs) can begin when § A is green and at least one of § B / § C / § D has shipped a working capture path end-to-end.

---

## Open follow-ups not blocking Phase 5

- **`teambrain-auth` dev refresh daemon** — developer-side helper that keeps a fresh 24h JWT on disk for CLI clients. Convenience, still deferred (§ J of Phase 4).
- **Exchange audit / rate limiting** — an `api_token_uses` audit table or per-token rate limit on `/token/exchange`. Not required for the pilot; revisit if the exchange surface needs hardening.
- **Asymmetric-key migration** — minting assumes legacy **HS256** over `JWT_SECRET` (matches this stack's current anon/service JWTs and the dispatcher's legacy-verify path). If the stack ever migrates to Supabase's asymmetric (ES256/JWKS) keys, `teambrain-token`'s `mintAccessToken` must switch to signing with the ES256 private key.

---

## Notes for the next session

- JWT lifetime for humans is 24h (`GOTRUE_JWT_EXP=86400`); minted bot access tokens are intentionally far shorter (15 min) to bound revocation latency.
- The exchange endpoint is the only path that is reachable without a real user JWT — keep its surface minimal and its validation strict.
- Default project slug on the server is `fabric-testbed/fabric-core-api`; token-scoped callers operate against the token's bound `project_id`, independent of that default.
